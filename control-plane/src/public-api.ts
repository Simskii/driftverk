import { isBillingError } from "./billing.js";
import { streamSSE } from "hono/streaming";
import { createPrebuild, getPrebuild, listPrebuilds } from "./prebuilds.js";
import { deleteProjectSetup, getProjectSetup, listProjectSetups, saveProjectSetup } from "./project-setups.js";
import { claimPreparedPreview, preparedPreviewStatus, configurePreparedPreview } from "./prepared-previews.js";
import { createExecution, getExecution, cancelExecution, deleteExecution, executionOutput, executionArtifact, executionTerminal } from "./executions.js";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { Context, Hono, Next } from "hono";
import type { PoolClient } from "pg";
import { authenticateApiKey, type ApiPrincipal, type ApiScope } from "./api-keys.js";
import { db } from "./db.js";
import { createPreviewGrant, PreviewError } from "./preview.js";
import {
  changeEnvironmentStateForActor,
  createEnvironmentForActor,
  EnvironmentServiceError,
  getEnvironmentForActor,
  getOperationForActor,
  listEnvironmentsForActor,
  listSnapshotsForActor,
  type EnvironmentActor,
} from "./environment-service.js";
import type { AppEnv } from "./types.js";

const docsRoot = new URL("../docs/", import.meta.url);
const [apiGuide, githubActionsGuide, openApiDocument] = await Promise.all([
  readFile(new URL("api.md", docsRoot), "utf8"),
  readFile(new URL("github-actions.md", docsRoot), "utf8"),
  readFile(new URL("openapi.yaml", docsRoot), "utf8"),
]);

type IdempotentResult = { status: number; body: Record<string, unknown>; replayed: boolean };

function actorFor(principal: ApiPrincipal): EnvironmentActor {
  return {
    organizationId: principal.organizationId,
    organizationName: principal.organizationName,
    organizationSlug: principal.organizationSlug,
    actorUserId: principal.actorUserId,
    automationIdPrefix: principal.automationIdPrefix,
    accessUserId: principal.keyId ? undefined : principal.actorUserId,
  };
}

function requestId(c: Context<AppEnv>): string {
  return c.get("requestId");
}

function apiJson(c: Context<AppEnv>, body: unknown, status = 200) {
  c.header("Cache-Control", "no-store");
  c.header("X-Request-Id", requestId(c));
  return c.json(body, status as 200);
}

async function requireApiKey(c: Context<AppEnv>, next: Next) {
  if (c.req.path === "/v1/docs" || c.req.path === "/v1/docs/github-actions" || c.req.path === "/v1/openapi.yaml") return next();
  const principal = await authenticateApiKey(c.req.raw);
  if (!principal) return apiJson(c, { error: { code: "unauthorized", message: "A valid Driftverk API key is required" } }, 401);
  c.set("apiPrincipal", principal);
  await next();
}

function requireScope(scope: ApiScope) {
  return async (c: Context<AppEnv>, next: Next) => {
    if (!c.get("apiPrincipal").scopes.includes(scope))
      return apiJson(c, { error: { code: "forbidden", message: `The API key requires the ${scope} scope` } }, 403);
    await next();
  };
}

export async function recordApiAuditEvent(
  principal: ApiPrincipal,
  requestIdValue: string,
  action: string,
  resourceId: string | null,
  status: number,
  metadata: Record<string, unknown> = {},
) {
  try {
    await db.query(
      `INSERT INTO api_audit_events
         (id, organization_id, api_key_id, oauth_subject, request_id, action, resource_id, status, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [`audit_${crypto.randomUUID()}`, principal.organizationId, principal.keyId,
       principal.keyId ? null : principal.credentialId, requestIdValue, action, resourceId, status,
       JSON.stringify(metadata)],
    );
  } catch (error) {
    console.error(JSON.stringify({
      event: "api_audit_write_failed",
      request_id: requestIdValue,
      message: error instanceof Error ? error.message : "Unknown audit error",
    }));
  }
}

export async function runIdempotent(
  principal: ApiPrincipal,
  key: string,
  fingerprint: unknown,
  operation: (client: PoolClient) => Promise<{ status: number; body: Record<string, unknown> }>,
): Promise<IdempotentResult> {
  if (!/^[A-Za-z0-9._:-]{8,200}$/.test(key))
    throw new EnvironmentServiceError(400, "Idempotency-Key must contain 8 to 200 safe characters");
  const requestHash = createHash("sha256").update(JSON.stringify(fingerprint)).digest("hex");
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const reservation = await client.query<{ credential_id: string }>(
      `INSERT INTO api_idempotency_keys (credential_id, idempotency_key, request_hash)
       VALUES ($1, $2, $3) ON CONFLICT DO NOTHING RETURNING credential_id`,
      [principal.credentialId, key, requestHash],
    );
    if (!reservation.rowCount) {
      const existing = await client.query<{ request_hash: string; response_status: number | null; response_body: Record<string, unknown> | null }>(
        `SELECT request_hash, response_status, response_body FROM api_idempotency_keys
         WHERE credential_id = $1 AND idempotency_key = $2`,
        [principal.credentialId, key],
      );
      const row = existing.rows[0];
      if (!row || row.request_hash !== requestHash)
        throw new EnvironmentServiceError(409, "Idempotency key was already used for another request");
      if (row.response_status === null || row.response_body === null)
        throw new EnvironmentServiceError(409, "The matching request is still being processed");
      await client.query("COMMIT");
      return { status: row.response_status, body: row.response_body, replayed: true };
    }
    const result = await operation(client);
    await client.query(
      `UPDATE api_idempotency_keys SET response_status = $3, response_body = $4
       WHERE credential_id = $1 AND idempotency_key = $2`,
      [principal.credentialId, key, result.status, JSON.stringify(result.body)],
    );
    await client.query("COMMIT");
    return { ...result, replayed: false };
  } catch (error) {
    await client.query("ROLLBACK");
    if (error instanceof EnvironmentServiceError && error.status < 500) {
      const body = { error: { code: "request_rejected", message: error.message } };
      return { status: error.status, body, replayed: false };
    }
    throw error;
  } finally {
    client.release();
  }
}

function errorResponse(c: Context<AppEnv>, error: unknown) {
  if (isBillingError(error)) return apiJson(c, { error: { code: "payment_required", message: error.message } }, 402);
  if (error instanceof EnvironmentServiceError)
    return apiJson(c, { error: { code: "request_rejected", message: error.message } }, error.status);
  throw error;
}

function idempotencyKey(c: Context<AppEnv>): string {
  return c.req.header("idempotency-key")?.trim() ?? "";
}

export function registerPublicApiRoutes(app: Hono<AppEnv>) {
  app.get("/v1/docs", (c) => c.body(apiGuide, 200, { "Content-Type": "text/markdown; charset=utf-8", "Cache-Control": "public, max-age=300" }));
  app.get("/v1/docs/github-actions", (c) => c.body(githubActionsGuide, 200, { "Content-Type": "text/markdown; charset=utf-8", "Cache-Control": "public, max-age=300" }));
  app.get("/v1/openapi.yaml", (c) => c.body(openApiDocument, 200, { "Content-Type": "application/yaml; charset=utf-8", "Cache-Control": "public, max-age=300" }));
  app.use("/v1/*", requireApiKey);

  app.get("/v1/prebuilds", requireScope("read"), async c => {
    try { return apiJson(c,{data:await listPrebuilds(actorFor(c.get("apiPrincipal")))}); } catch(error) { return errorResponse(c,error); }
  });
  app.get("/v1/project-setups", requireScope("read"), async c => {
    try { return apiJson(c, { data: await listProjectSetups(actorFor(c.get("apiPrincipal"))) }); }
    catch (error) { return errorResponse(c, error); }
  });
  app.get("/v1/project-setups/:id", requireScope("read"), async c => {
    try { return apiJson(c, { data: await getProjectSetup(actorFor(c.get("apiPrincipal")), c.req.param("id")!) }); }
    catch (error) { return errorResponse(c, error); }
  });
  for (const method of ["post", "put", "delete"] as const) {
    app[method](method === "post" ? "/v1/project-setups" : "/v1/project-setups/:id", requireScope(method === "delete" ? "delete" : "write"), async c => {
      const principal = c.get("apiPrincipal");
      const input = method === "delete" ? undefined : await c.req.json().catch(() => null);
      try {
        const response = await runIdempotent(principal, idempotencyKey(c), { method: c.req.method, path: c.req.path, input }, async client => ({
          status: method === "post" ? 201 : 200,
          body: { data: method === "delete"
            ? await deleteProjectSetup(actorFor(principal), c.req.param("id")!, client)
            : await saveProjectSetup(actorFor(principal), input, client, method === "put" ? c.req.param("id")! : undefined) },
        }));
        c.header("Idempotent-Replayed", String(response.replayed));
        const data = response.body.data as { id?: string } | undefined;
        await recordApiAuditEvent(principal, requestId(c), `project_setup.${method === "post" ? "create" : method === "put" ? "update" : "delete"}`, data?.id ?? c.req.param("id") ?? null, response.status);
        return apiJson(c, response.body, response.status);
      } catch (error) { return errorResponse(c, error); }
    });
  }
  app.get("/v1/prebuilds/:id", requireScope("read"), async c => {
    try { return apiJson(c, { data: await getPrebuild(actorFor(c.get("apiPrincipal")), c.req.param("id")!) }); }
    catch (error) { return errorResponse(c, error); }
  });
  app.post("/v1/prebuilds", requireScope("write"), async c => {
    const principal = c.get("apiPrincipal"), input = await c.req.json().catch(()=>null);
    if (!input) return apiJson(c,{error:{message:"A JSON body is required"}},400);
    try {
      const response = await runIdempotent(principal,idempotencyKey(c),{path:c.req.path,input},async client=>({status:202,body:{data:await createPrebuild(actorFor(principal),String(input.template_id || ""),input.compute_node_id,client)}}));
      await recordApiAuditEvent(principal,requestId(c),"prebuild.create",null,response.status);
      return apiJson(c,response.body,response.status);
    } catch(error) { return errorResponse(c,error); }
  });
  app.post("/v1/environments/:id/executions", requireScope("write"), async c => {
    const principal = c.get("apiPrincipal"), input = await c.req.json().catch(()=>null);
    if (!input) return apiJson(c,{error:{message:"A JSON body is required"}},400);
    try {
      const response = await runIdempotent(principal,idempotencyKey(c),{path:c.req.path,input},async client=>({status:202,body:{data:await createExecution(actorFor(principal),c.req.param("id")!,input,client)}}));
      await recordApiAuditEvent(principal,requestId(c),"execution.create",c.req.param("id")!,response.status);
      return apiJson(c,response.body,response.status);
    } catch(error) { return errorResponse(c,error); }
  });
  app.get("/v1/project-setups/:id/prepared-preview", requireScope("read"), async c => {
    try { return apiJson(c,{data:await preparedPreviewStatus(actorFor(c.get("apiPrincipal")),c.req.param("id")!)}); }
    catch(error) { return errorResponse(c,error); }
  });
  for (const action of ["configure", "claim"] as const) {
    app.post(`/v1/project-setups/:id/prepared-preview/${action}`, requireScope("write"), async c => {
      const principal=c.get("apiPrincipal"), input=await c.req.json().catch(()=>null);
      if (!input) return apiJson(c,{error:{message:"A JSON body is required"}},400);
      try {
        const result=await runIdempotent(principal,idempotencyKey(c),{path:c.req.path,input},async client=>({status:200,body:{data:action === "claim"
          ? await claimPreparedPreview(actorFor(principal),c.req.param("id")!,input.name,client)
          : await configurePreparedPreview(actorFor(principal),c.req.param("id")!,input.enabled,client)}}));
        await recordApiAuditEvent(principal,requestId(c),`prepared-preview.${action}`,c.req.param("id")!,result.status);
        return apiJson(c,result.body,result.status);
      } catch(error) { return errorResponse(c,error); }
    });
  }
  app.get("/v1/executions/:id", requireScope("read"), async c => {
    try { return apiJson(c,{data:await getExecution(actorFor(c.get("apiPrincipal")),c.req.param("id")!)}); } catch(error) { return errorResponse(c,error); }
  });
  app.get("/v1/executions/:id/output", requireScope("read"), async c => {
    try { return apiJson(c,{data:await executionOutput(actorFor(c.get("apiPrincipal")),c.req.param("id")!,c.req.query("after") || "0")}); } catch(error) { return errorResponse(c,error); }
  });
  app.get("/v1/executions/:id/events", requireScope("read"), async c => {
    const actor = actorFor(c.get("apiPrincipal")), id = c.req.param("id")!;
    let cursor = c.req.header("last-event-id") || c.req.query("after") || "0";
    try { await executionOutput(actor,id,cursor); } catch(error) { return errorResponse(c,error); }
    c.header("Cache-Control","no-store"); c.header("X-Accel-Buffering","no");
    return streamSSE(c,async stream=>{
      const deadline = Date.now()+30000;
      while(!stream.aborted && Date.now()<deadline) {
        // Read terminal state before output: its final report commits output and status together.
        const execution = await getExecution(actor,id);
        const chunks = await executionOutput(actor,id,cursor);
        for(const chunk of chunks) { await stream.writeSSE({id:chunk.sequence,event:"output",data:JSON.stringify(chunk)}); cursor=chunk.sequence; }
        if(executionTerminal.has(execution.status) && chunks.length < 100) { await stream.writeSSE({event:"done",data:JSON.stringify(execution)}); return; }
        await stream.sleep(500);
      }
    });
  });
  app.post("/v1/executions/:id/cancel", requireScope("write"), async c => {
    const principal=c.get("apiPrincipal");
    try { const value=await cancelExecution(actorFor(principal),c.req.param("id")!); await recordApiAuditEvent(principal,requestId(c),"execution.cancel",c.req.param("id")!,200); return apiJson(c,{data:value}); } catch(error) { return errorResponse(c,error); }
  });
  app.delete("/v1/executions/:id", requireScope("delete"), async c => {
    const principal=c.get("apiPrincipal");
    try { const value=await deleteExecution(actorFor(principal),c.req.param("id")!); await recordApiAuditEvent(principal,requestId(c),"execution.delete",c.req.param("id")!,200); return apiJson(c,{data:value}); } catch(error) { return errorResponse(c,error); }
  });
  app.get("/v1/executions/:id/artifact", requireScope("read"), async c => {
    try {
      const data=await executionArtifact(actorFor(c.get("apiPrincipal")),c.req.param("id")!,c.req.query("path") || "");
      c.header("Content-Type","application/octet-stream"); c.header("Content-Disposition",'attachment; filename="artifact"'); c.header("Cache-Control","no-store");
      return c.body(new Uint8Array(data));
    } catch(error) { return errorResponse(c,error); }
  });

  app.get("/v1/me", requireScope("read"), (c) => {
    const principal = c.get("apiPrincipal");
    return apiJson(c, {
      organization: { id: principal.organizationId, name: principal.organizationName },
      api_key: {
        id: principal.keyId,
        name: principal.keyName,
        scopes: principal.scopes,
        automation_id_prefix: principal.automationIdPrefix,
      },
    });
  });
  app.get("/v1/environments", requireScope("read"), async (c) => {
    const principal = c.get("apiPrincipal");
    return apiJson(c, { data: await listEnvironmentsForActor(actorFor(principal)) });
  });
  app.get("/v1/environments/:id", requireScope("read"), async (c) => {
    try {
      const principal = c.get("apiPrincipal");
      return apiJson(c, { data: await getEnvironmentForActor(actorFor(principal), c.req.param("id")!) });
    } catch (error) { return errorResponse(c, error); }
  });
  app.get("/v1/snapshots", requireScope("read"), async (c) => {
    const principal = c.get("apiPrincipal");
    return apiJson(c, { data: await listSnapshotsForActor(actorFor(principal)) });
  });
  app.get("/v1/operations/:id", requireScope("read"), async (c) => {
    try {
      const principal = c.get("apiPrincipal");
      return apiJson(c, { data: await getOperationForActor(actorFor(principal), c.req.param("id")!) });
    } catch (error) { return errorResponse(c, error); }
  });
  app.post("/v1/environments/:id/ports/:port/preview", requireScope("write"), async (c) => {
    const principal = c.get("apiPrincipal");
    const environmentId = c.req.param("id")!;
    try {
      await getEnvironmentForActor(actorFor(principal), environmentId);
      const preview = await createPreviewGrant(principal.organizationId, environmentId, Number(c.req.param("port")), actorFor(principal).accessUserId);
      await recordApiAuditEvent(principal, requestId(c), "environment.preview.create", environmentId, 200);
      return apiJson(c, { data: preview });
    } catch (error) {
      if (error instanceof PreviewError)
        return apiJson(c, { error: { code: "request_rejected", message: error.message } }, error.status);
      return errorResponse(c, error);
    }
  });
  app.post("/v1/environments", requireScope("write"), async (c) => {
    const principal = c.get("apiPrincipal");
    const input = await c.req.json<Record<string, unknown>>().catch(() => null);
    if (!input) return apiJson(c, { error: { code: "invalid_json", message: "A JSON body is required" } }, 400);
    try {
      const result = await runIdempotent(principal, idempotencyKey(c), { method: "POST", path: c.req.path, input }, async (client) => ({
        status: 202,
        body: { data: await createEnvironmentForActor(actorFor(principal), input, client) },
      }));
      c.header("Idempotent-Replayed", String(result.replayed));
      const resourceId = typeof result.body.data === "object" && result.body.data ? String((result.body.data as Record<string, unknown>).environment_id ?? "") : null;
      await recordApiAuditEvent(principal, requestId(c), "environment.create", resourceId || null, result.status, {
        code_trust: principal.automationIdPrefix ? "untrusted" : input.code_trust === "trusted" ? "trusted" : "untrusted",
        automation_id: typeof input.automation_id === "string" ? input.automation_id : null,
        source_revision: typeof input.source_revision === "string" ? input.source_revision : null,
        organization_secret_names: Array.isArray(input.organization_secret_names) ? input.organization_secret_names : [],
        environment_variable_names: Array.isArray(input.environment_variables)
          ? input.environment_variables.map((item) => item && typeof item === "object" ? String((item as Record<string, unknown>).name ?? "") : "").filter(Boolean)
          : [],
      });
      return apiJson(c, result.body, result.status);
    } catch (error) { return errorResponse(c, error); }
  });

  for (const action of ["start", "stop"] as const) {
    app.post(`/v1/environments/:id/${action}`, requireScope("write"), async (c) => {
      const principal = c.get("apiPrincipal");
      const environmentId = c.req.param("id")!;
      try {
        const result = await runIdempotent(principal, idempotencyKey(c), { method: "POST", path: c.req.path }, async (client) => ({
          status: 202,
          body: { data: await changeEnvironmentStateForActor(actorFor(principal), environmentId, action, client) },
        }));
        c.header("Idempotent-Replayed", String(result.replayed));
        await recordApiAuditEvent(principal, requestId(c), `environment.${action}`, environmentId, result.status);
        return apiJson(c, result.body, result.status);
      } catch (error) { return errorResponse(c, error); }
    });
  }
  app.delete("/v1/environments/:id", requireScope("delete"), async (c) => {
    const principal = c.get("apiPrincipal");
    const environmentId = c.req.param("id")!;
    try {
      const result = await runIdempotent(principal, idempotencyKey(c), { method: "DELETE", path: c.req.path }, async (client) => ({
        status: 202,
        body: { data: await changeEnvironmentStateForActor(actorFor(principal), environmentId, "delete", client) },
      }));
      c.header("Idempotent-Replayed", String(result.replayed));
      await recordApiAuditEvent(principal, requestId(c), "environment.delete", environmentId, result.status);
      return apiJson(c, result.body, result.status);
    } catch (error) { return errorResponse(c, error); }
  });
}

export { actorFor };
