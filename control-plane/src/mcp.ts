import { isBillingError } from "./billing.js";
import { createPrebuild, getPrebuild, listPrebuilds } from "./prebuilds.js";
import { deleteProjectSetup, getProjectSetup, listProjectSetups, saveProjectSetup } from "./project-setups.js";
import { createPreviewGrant, PreviewError } from "./preview.js";
import { createExecution, getExecution, cancelExecution, deleteExecution, executionOutput, executionArtifact } from "./executions.js";
import { createMcpHandler, hostHeaderValidationResponse, McpServer } from "@modelcontextprotocol/server";
import { requireMcpAuth } from "@better-auth/mcp";
import type { Context } from "hono";
import type { JWTPayload } from "jose";
import { z } from "zod";
import { auth } from "./auth.js";
import { authenticateApiKey, type ApiPrincipal } from "./api-keys.js";
import { config } from "./config.js";
import { db } from "./db.js";
import {
  changeEnvironmentStateForActor,
  createEnvironmentForActor,
  EnvironmentServiceError,
  getEnvironmentForActor,
  getOperationForActor,
  listEnvironmentsForActor,
  listSnapshotsForActor,
} from "./environment-service.js";
import { actorFor, recordApiAuditEvent, runIdempotent } from "./public-api.js";
import type { AppEnv } from "./types.js";

function result(value: unknown) {
  return { ...(value && typeof value === "object" && "error" in value ? { isError: true } : {}), content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

function failure(error: unknown) {
  if (!(error instanceof EnvironmentServiceError) && !(error instanceof PreviewError)) {
    console.error(JSON.stringify({
      event: "mcp_tool_failed",
      message: error instanceof Error ? error.message : "Unknown MCP tool error",
    }));
  }
  const message = error instanceof EnvironmentServiceError || error instanceof PreviewError || isBillingError(error) ? error.message : "The Driftverk request failed";
  return { isError: true, content: [{ type: "text" as const, text: message }] };
}

function createServer(principal: ApiPrincipal) {
  const server = new McpServer({ name: "Driftverk", version: "1.0.0" });
  const actor = actorFor(principal);

  const projectSetupInput = z.object({
    name: z.string().min(1).max(80),
    configuration: z.object({
      source_type: z.enum(["image", "snapshot"]).optional(),
      image: z.string().max(240).nullable().optional(),
      snapshot_id: z.string().nullable().optional(),
      registry_id: z.string().nullable().optional(),
      repository: z.string().max(200).nullable().optional().describe("GitHub owner/repository"),
      repository_branch: z.string().max(200).nullable().optional(),
      setup_command: z.string().max(8000).nullable().optional(),
      initialization_command: z.string().max(8000).nullable().optional(),
      startup_command: z.string().max(8000).nullable().optional(),
      readiness_command: z.string().max(8000).nullable().optional(),
      cpu: z.union([z.literal(1), z.literal(2), z.literal(4), z.literal(8)]).optional(),
      memory_mb: z.union([z.literal(1024), z.literal(2048), z.literal(4096), z.literal(8192), z.literal(16384)]).optional(),
      auto_stop_minutes: z.number().int().min(1).max(525600).nullable().optional(),
    }),
    idempotency_key: z.string().min(8).max(200),
  });
  server.registerTool("get_project_setup", {
    description: "Read one saved project setup and its configuration.",
    inputSchema: z.object({ template_id: z.string().min(1) }), annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ template_id }) => {
    try { return result({ project_setup: await getProjectSetup(actor, template_id) }); } catch (error) { return failure(error); }
  });
  server.registerTool("get_prebuild", {
    description: "Read a prebuild by ID, including build status, pinned revision and error.",
    inputSchema: z.object({ prebuild_id: z.string().min(1) }), annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ prebuild_id }) => {
    try { return result({ prebuild: await getPrebuild(actor, prebuild_id) }); } catch (error) { return failure(error); }
  });
  if (principal.scopes.includes("write")) {
    for (const action of ["create", "update"] as const) {
      server.registerTool(`${action}_project_setup`, {
        description: action === "create" ? "Save reusable environment configuration. Does not build or start compute. Never include credentials in commands or images."
          : "Replace a saved setup's name and full configuration. Existing prebuilds and environments retain their configuration.",
        inputSchema: action === "create" ? projectSetupInput : projectSetupInput.extend({ template_id: z.string().min(1) }),
        annotations: { readOnlyHint: false, destructiveHint: action === "update", idempotentHint: true, openWorldHint: false },
      }, async ({ idempotency_key, ...input }) => {
        try {
          const id = "template_id" in input ? String(input.template_id) : undefined;
          const response = await runIdempotent(principal, idempotency_key, { tool: `${action}_project_setup`, input }, async client => ({
            status: action === "create" ? 201 : 200, body: { data: await saveProjectSetup(actor, input, client, id) },
          }));
          const data = response.body.data as { id?: string } | undefined;
          await recordApiAuditEvent(principal, `mcp_${crypto.randomUUID()}`, `project_setup.${action}`, data?.id ?? id ?? null, response.status, { client: "mcp" });
          return result(response.body);
        } catch (error) { return failure(error); }
      });
    }
    server.registerTool("create_preview", {
      description: "Create a private, one-hour HTTP preview URL for a provisioned environment port. May wake a stopped environment. Treat the URL as a credential.",
      inputSchema: z.object({ environment_id: z.string().min(1), port: z.number().int().min(1).max(65535) }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    }, async ({ environment_id, port }) => {
      try {
        await getEnvironmentForActor(actor, environment_id);
        const preview = await createPreviewGrant(actor.organizationId, environment_id, port, actor.accessUserId);
        await recordApiAuditEvent(principal, `mcp_${crypto.randomUUID()}`, "environment.preview.create", environment_id, 200, { client: "mcp" });
        return result(preview);
      } catch (error) { return failure(error); }
    });
  }
  if (principal.scopes.includes("delete")) {
    server.registerTool("delete_project_setup", {
      description: "Delete a saved configuration. Existing prebuilds and environments are retained.",
      inputSchema: z.object({ template_id: z.string().min(1), idempotency_key: z.string().min(8).max(200) }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    }, async ({ template_id, idempotency_key }) => {
      try {
        const response = await runIdempotent(principal, idempotency_key, { tool: "delete_project_setup", template_id }, async client => ({
          status: 200, body: { data: await deleteProjectSetup(actor, template_id, client) },
        }));
        await recordApiAuditEvent(principal, `mcp_${crypto.randomUUID()}`, "project_setup.delete", template_id, response.status, { client: "mcp" });
        return result(response.body);
      } catch (error) { return failure(error); }
    });
  }

  server.registerTool("list_environments", {
    title: "List Driftverk environments",
    description: "List active development environments in the authenticated Driftverk organization.",
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async () => {
    try { return result({ environments: await listEnvironmentsForActor(actor) }); }
    catch (error) { return failure(error); }
  });

  server.registerTool("get_environment", {
    title: "Get a Driftverk environment",
    description: "Get the current state, source, resources and connection identity for one environment.",
    inputSchema: z.object({ environment_id: z.string().min(1).describe("The Driftverk environment ID") }),
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ environment_id }) => {
    try { return result({ environment: await getEnvironmentForActor(actor, environment_id) }); }
    catch (error) { return failure(error); }
  });

  server.registerTool("list_snapshots", {
    title: "List Driftverk snapshots",
    description: "List snapshots that can be used as the source for a new environment.",
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async () => {
    try { return result({ snapshots: await listSnapshotsForActor(actor) }); }
    catch (error) { return failure(error); }
  });

  server.registerTool("get_operation", {
    title: "Get operation status",
    description: "Check whether an asynchronous environment operation is queued, leased to a compute agent, succeeded or failed.",
    inputSchema: z.object({ operation_id: z.string().min(1).describe("The operation ID returned by another tool") }),
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async ({ operation_id }) => {
    try { return result({ operation: await getOperationForActor(actor, operation_id) }); }
    catch (error) { return failure(error); }
  });

  if (principal.scopes.includes("write")) {
    server.registerTool("create_environment", {
      title: "Create a Driftverk environment",
      description: "Create an isolated development environment from an OCI image or ready snapshot. Returns an operation ID that can be checked with get_operation.",
      inputSchema: z.object({
        idempotency_key: z.string().min(8).max(200).describe("A unique stable key for this intended creation"),
        name: z.string().min(1).max(63).optional().describe("Lowercase letters, numbers and hyphens"),
        source_type: z.enum(["image", "snapshot"]).default("image"),
        image: z.string().max(240).optional().describe("OCI image pinned as registry/repository@sha256:<digest> when source_type is image"),
        prebuild_id: z.string().optional().describe("Ready clean prebuild ID. Requires code_trust trusted."),
        initialization_command: z.string().max(8000).optional(),
        startup_command: z.string().max(8000).optional(),
        readiness_command: z.string().max(8000).optional(),
        preview_enabled: z.boolean().default(true).describe("Allow signed HTTP preview links for this environment"),
        snapshot_id: z.string().optional().describe("Ready snapshot ID when source_type is snapshot"),
        registry_id: z.string().optional().describe("Registry ID when the image requires organization credentials"),
        compute_node_id: z.string().optional().describe("Hybrid host ID from Compute hosts. Omit for automatic placement."),
        cpu: z.union([z.literal(1), z.literal(2), z.literal(4), z.literal(8)]).optional(),
        memory_mb: z.union([z.literal(1024), z.literal(2048), z.literal(4096), z.literal(8192), z.literal(16384)]).optional(),
        auto_stop_minutes: z.number().int().min(1).max(525600).nullable().optional().describe("Idle timeout in minutes; null disables auto-stop"),
        auto_delete_minutes: z.number().int().min(1).max(525600).nullable().optional().describe("Total lifetime in minutes; null disables auto-delete for trusted code"),
        disk_gb: z.union([z.literal(20), z.literal(40), z.literal(50), z.literal(80), z.literal(100)]).default(40),
        code_trust: z.enum(["untrusted", "trusted"]).default("untrusted")
          .describe("Untrusted is the safe default and cannot receive environment variables"),
        automation_id: z.string().max(200).optional().describe("github:<numeric-repository-id>:pr:<number>"),
        source_revision: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/).optional(),
        organization_secret_names: z.array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/)).max(25).optional().describe("Required organization secrets copied into a trusted environment at creation; cannot overlap direct variables"),
        environment_variables: z.array(z.object({ name: z.string(), value: z.string() })).max(25).optional()
          .describe("Readable by code in the environment. Allowed only when code_trust is trusted"),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    }, async ({ idempotency_key, ...input }) => {
      try {
        const response = await runIdempotent(principal, idempotency_key,
          { tool: "create_environment", input },
          async (client) => ({ status: 202, body: { data: await createEnvironmentForActor(actor, input, client) } }));
        const data = response.body.data as Record<string, unknown> | undefined;
        await recordApiAuditEvent(principal, `mcp_${crypto.randomUUID()}`, "environment.create", String(data?.environment_id ?? "") || null, response.status, { client: "mcp" });
        return result(response.body);
      } catch (error) { return failure(error); }
    });

    for (const action of ["start", "stop"] as const) {
      server.registerTool(`${action}_environment`, {
        title: `${action === "start" ? "Start" : "Stop"} a Driftverk environment`,
        description: `${action === "start" ? "Start" : "Stop"} one environment. Returns an operation ID for get_operation.`,
        inputSchema: z.object({
          environment_id: z.string().min(1),
          idempotency_key: z.string().min(8).max(200),
        }),
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      }, async ({ environment_id, idempotency_key }) => {
        try {
          const response = await runIdempotent(principal, idempotency_key,
            { tool: `${action}_environment`, environment_id },
            async (client) => ({ status: 202, body: { data: await changeEnvironmentStateForActor(actor, environment_id, action, client) } }));
          await recordApiAuditEvent(principal, `mcp_${crypto.randomUUID()}`, `environment.${action}`, environment_id, response.status, { client: "mcp" });
          return result(response.body);
        } catch (error) { return failure(error); }
      });
    }
  }

  if (principal.scopes.includes("delete")) {
    server.registerTool("delete_environment", {
      title: "Delete a Driftverk environment",
      description: "Permanently delete an environment. The confirm_environment_name value must exactly match the current environment name.",
      inputSchema: z.object({
        environment_id: z.string().min(1),
        confirm_environment_name: z.string().min(1),
        idempotency_key: z.string().min(8).max(200),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    }, async ({ environment_id, confirm_environment_name, idempotency_key }) => {
      try {
        const environment = await getEnvironmentForActor(actor, environment_id);
        if (environment.name !== confirm_environment_name)
          throw new EnvironmentServiceError(400, "Confirmation name does not match the environment");
        const response = await runIdempotent(principal, idempotency_key,
          { tool: "delete_environment", environment_id, confirm_environment_name },
          async (client) => ({ status: 202, body: { data: await changeEnvironmentStateForActor(actor, environment_id, "delete", client) } }));
        await recordApiAuditEvent(principal, `mcp_${crypto.randomUUID()}`, "environment.delete", environment_id, response.status, { client: "mcp" });
        return result(response.body);
      } catch (error) { return failure(error); }
    });
  }
  if (principal.scopes.includes("read")) {
    server.registerTool("list_project_setups", { description: "List reusable project setups for building clean prebuilds", inputSchema: z.object({}), annotations: { readOnlyHint: true } }, async () => {
      try {
        return result(await listProjectSetups(actor));
      } catch (error) { return failure(error); }
    });
    server.registerTool("list_prebuilds", { description:"List clean project prebuilds in this organization", inputSchema:z.object({}), annotations:{readOnlyHint:true} }, async()=>{try{return result(await listPrebuilds(actor));}catch(error){return failure(error);}});
    server.registerTool("get_execution", { description:"Get command status, exit code and artifact names", inputSchema:z.object({execution_id:z.string()}), annotations:{readOnlyHint:true} }, async({execution_id})=>{try{return result(await getExecution(actor,execution_id));}catch(error){return failure(error);}});
    server.registerTool("read_execution_output", { description:"Read stdout/stderr as base64 chunks. Pass the last sequence as after to reconnect without duplicate output.", inputSchema:z.object({execution_id:z.string(),after:z.string().default("0")}), annotations:{readOnlyHint:true} }, async({execution_id,after})=>{try{return result(await executionOutput(actor,execution_id,after));}catch(error){return failure(error);}});
    server.registerTool("get_execution_artifact", { description:"Download a declared execution artifact as base64, maximum 128 KiB", inputSchema:z.object({execution_id:z.string(),path:z.string()}), annotations:{readOnlyHint:true} }, async({execution_id,path})=>{try{return result({path,data:(await executionArtifact(actor,execution_id,path)).toString("base64")});}catch(error){return failure(error);}});
  }
  if (principal.scopes.includes("write")) {
    server.registerTool("build_prebuild", { description:"Build a clean reusable project setup without runtime variables or volumes", inputSchema:z.object({template_id:z.string(),compute_node_id:z.string().optional(),idempotency_key:z.string().min(8)}), annotations:{idempotentHint:true} }, async({template_id,compute_node_id,idempotency_key})=>{
      try { const response=await runIdempotent(principal,idempotency_key,{tool:"build_prebuild",template_id,compute_node_id},async client=>({status:202,body:{data:await createPrebuild(actor,template_id,compute_node_id,client)}})); await recordApiAuditEvent(principal,`mcp_${crypto.randomUUID()}`,"prebuild.create",null,response.status); return result(response.body); }catch(error){return failure(error);}
    });
    server.registerTool("execute_command", { description:"Start one durable shell command in a running environment. Returns an execution ID for output, cancellation and artifacts. Timeout up to one hour.", inputSchema:z.object({environment_id:z.string(),command:z.string().min(1).max(8000),cwd:z.string().optional(),environment_variables:z.array(z.object({name:z.string(),value:z.string().max(32768)})).max(25).optional(),timeout_seconds:z.number().int().min(1).max(3600).default(900),artifacts:z.array(z.string()).max(4).default([]),idempotency_key:z.string().min(8)}), annotations:{idempotentHint:true,openWorldHint:true} }, async({environment_id,idempotency_key,...input})=>{
      try { const response=await runIdempotent(principal,idempotency_key,{tool:"execute_command",environment_id,input},async client=>({status:202,body:{data:await createExecution(actor,environment_id,input,client)}})); await recordApiAuditEvent(principal,`mcp_${crypto.randomUUID()}`,"execution.create",environment_id,response.status); return result(response.body); }catch(error){return failure(error);}
    });
    server.registerTool("cancel_execution", { description:"Request cancellation of a command process group. Poll get_execution until terminal.",inputSchema:z.object({execution_id:z.string()}),annotations:{idempotentHint:true} },async({execution_id})=>{try{const value=await cancelExecution(actor,execution_id);await recordApiAuditEvent(principal,`mcp_${crypto.randomUUID()}`,"execution.cancel",execution_id,200);return result(value);}catch(error){return failure(error);}});
  }
  if (principal.scopes.includes("delete")) server.registerTool("delete_execution", {description:"Delete completed command output and artifacts",inputSchema:z.object({execution_id:z.string()}),annotations:{destructiveHint:true}},async({execution_id})=>{try{const value=await deleteExecution(actor,execution_id);await recordApiAuditEvent(principal,`mcp_${crypto.randomUUID()}`,"execution.delete",execution_id,200);return result(value);}catch(error){return failure(error);}});
  return server;
}

async function oauthPrincipal(claims: JWTPayload): Promise<ApiPrincipal | null> {
  const organizationId = typeof claims.organization_id === "string" ? claims.organization_id : "";
  const userId = typeof claims.sub === "string" ? claims.sub : "";
  if (!organizationId || !userId) return null;
  const membership = await db.query<{
    role: string;
    organization_name: string;
    organization_slug: string;
  }>(
    `SELECT memberships.role, organizations.name AS organization_name, organizations.slug AS organization_slug
     FROM memberships
     JOIN organizations ON organizations.id = memberships.organization_id
     WHERE memberships.organization_id = $1 AND memberships.user_id = $2`,
    [organizationId, userId],
  );
  const row = membership.rows[0];
  if (!row) return null;
  const granted = new Set(typeof claims.scope === "string" ? claims.scope.split(/\s+/) : []);
  const scopes: ApiPrincipal["scopes"] = ["read"];
  if (row.role === "admin" && granted.has("mcp:write")) scopes.push("write");
  if (row.role === "admin" && granted.has("mcp:delete")) scopes.push("delete");
  const clientId = typeof claims.client_id === "string" ? claims.client_id : "unknown";
  return {
    credentialId: `oauth:${organizationId}:${userId}:${clientId}`,
    keyId: null,
    keyName: "OAuth connection",
    organizationId,
    organizationName: row.organization_name,
    organizationSlug: row.organization_slug,
    actorUserId: userId,
    scopes,
    automationIdPrefix: null,
  };
}

async function serveMcp(request: Request, principal: ApiPrincipal) {
  const handler = createMcpHandler(() => createServer(principal), {
    legacy: "reject",
    onerror: (error) => console.error(JSON.stringify({ event: "mcp_request_failed", message: error.message })),
  });
  return handler.fetch(request);
}

const handleOAuthMcp = requireMcpAuth(auth, async (request, claims) => {
  const principal = await oauthPrincipal(claims);
  if (!principal) {
    return new Response(JSON.stringify({ error: "invalid_token", error_description: "The Driftverk membership is no longer valid" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }
  return serveMcp(request, principal);
}, {
  resource: new URL("/mcp", config.betterAuthUrl).toString(),
  requiredScopes: ["mcp:read"],
  challengeScopes: ["mcp:read", "mcp:write", "offline_access"],
});

export async function handleMcp(c: Context<AppEnv>) {
  const hostError = hostHeaderValidationResponse(c.req.raw, [
    new URL(config.betterAuthUrl).hostname,
    "localhost",
    "127.0.0.1",
  ]);
  if (hostError) return hostError;
  const principal = await authenticateApiKey(c.req.raw);
  if (principal?.scopes.includes("read")) return serveMcp(c.req.raw, principal);
  return handleOAuthMcp(c.req.raw);
}
