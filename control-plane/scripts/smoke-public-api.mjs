import { createHash, randomBytes, randomUUID } from "node:crypto";
import pg from "pg";

const baseUrl = process.env.DRIFTVERK_SMOKE_BASE_URL ?? "http://127.0.0.1:3000";
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const suffix = randomUUID().replaceAll("-", "");
const userId = `smoke_user_${suffix}`;
const organizationId = `smoke_org_${suffix}`;
const otherOrganizationId = `smoke_other_org_${suffix}`;
const keyId = `key_${suffix}`;
const secret = randomBytes(32).toString("base64url");
const token = `dvk_live_${keyId}.${secret}`;
const headers = { Authorization: `Bearer ${token}` };
const mcpHeaders = {
  "Content-Type": "application/json",
  Accept: "application/json, text/event-stream",
  "MCP-Protocol-Version": "2026-07-28",
};
const mcpMeta = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientCapabilities": {},
};

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function request(path, init = {}) {
  return fetch(`${baseUrl}${path}`, { ...init, headers: { ...headers, ...init.headers } });
}

try {
  await pool.query(
    `INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
     VALUES ($1, 'API smoke test', $2, true, now(), now())`,
    [userId, `${suffix}@smoke.invalid`],
  );
  await pool.query("INSERT INTO organizations (id, name, slug) VALUES ($1, 'API smoke', $2)", [organizationId, `api-smoke-${suffix}`]);
  await pool.query("INSERT INTO organizations (id, name, slug) VALUES ($1, 'Other smoke', $2)", [otherOrganizationId, `other-smoke-${suffix}`]);
  await pool.query(
    `INSERT INTO api_keys (id, organization_id, name, secret_hash, secret_prefix, scopes, created_by_user_id)
     VALUES ($1, $2, 'Smoke key', $3, 'dvk_live_smoke...', ARRAY['read','write','delete'], $4)`,
    [keyId, organizationId, createHash("sha256").update(secret).digest("hex"), userId],
  );
  const foreignEnvironmentId = `dev_${randomUUID()}`;
  await pool.query(
    `INSERT INTO sandboxes
     (id, preview_id, organization_id, name, source_type, source_image, cpu_count, memory_mb, disk_gb,
      state, desired_state, provisioning_step, created_by_user_id)
     VALUES ($1, $2, $3, 'foreign-smoke', 'image', 'debian:bookworm-slim', 1, 2048, 20,
             'stopped', 'stopped', 'ready', $4)`,
    [foreignEnvironmentId, randomUUID(), otherOrganizationId, userId],
  );

  assert((await request("/v1/me")).status === 200, "GET /v1/me failed");
  assert((await request(`/v1/environments/${foreignEnvironmentId}`)).status === 404, "Cross-organization environment was visible");

  const createBody = JSON.stringify({
    name: `smoke-${suffix.slice(0, 8)}`,
    source_type: "image",
    image: "debian:bookworm-slim",
    cpu: 1,
    memory_mb: 2048,
    disk_gb: 20,
    environment_variables: [{ name: "SMOKE_SECRET", value: `secret-${suffix}` }],
  });
  const createHeaders = { "Content-Type": "application/json", "Idempotency-Key": `smoke-create-${suffix}` };
  const created = await request("/v1/environments", { method: "POST", headers: createHeaders, body: createBody });
  assert(created.status === 202, `Create returned ${created.status}`);
  const createdBody = await created.json();
  const environmentId = createdBody.data?.environment_id;
  const operationId = createdBody.data?.operation_id;
  assert(environmentId && operationId, "Create response omitted resource IDs");

  const replay = await request("/v1/environments", { method: "POST", headers: createHeaders, body: createBody });
  assert(replay.status === 202 && replay.headers.get("idempotent-replayed") === "true", "Idempotent replay failed");
  const replayBody = await replay.json();
  assert(replayBody.data?.environment_id === environmentId, "Idempotent replay created another environment");

  const concurrentName = `concurrent-${suffix.slice(0, 8)}`;
  const concurrentBody = JSON.stringify({
    name: concurrentName,
    source_type: "image",
    image: "debian:bookworm-slim",
  });
  const concurrentHeaders = { "Content-Type": "application/json", "Idempotency-Key": `smoke-concurrent-${suffix}` };
  const [concurrentA, concurrentB] = await Promise.all([
    request("/v1/environments", { method: "POST", headers: concurrentHeaders, body: concurrentBody }),
    request("/v1/environments", { method: "POST", headers: concurrentHeaders, body: concurrentBody }),
  ]);
  assert(concurrentA.status === 202 && concurrentB.status === 202, "Concurrent idempotent requests did not both succeed");
  const [concurrentAData, concurrentBData] = await Promise.all([concurrentA.json(), concurrentB.json()]);
  assert(concurrentAData.data?.environment_id === concurrentBData.data?.environment_id, "Concurrent idempotent requests returned different environments");
  const concurrentCount = await pool.query(
    "SELECT count(*)::int AS count FROM sandboxes WHERE organization_id = $1 AND name = $2",
    [organizationId, concurrentName],
  );
  assert(concurrentCount.rows[0]?.count === 1, "Concurrent idempotent requests created duplicate environments");

  const changed = await request("/v1/environments", {
    method: "POST",
    headers: createHeaders,
    body: JSON.stringify({ ...JSON.parse(createBody), name: `changed-${suffix.slice(0, 8)}` }),
  });
  assert(changed.status === 409, "Changed idempotent request was not rejected");
  assert((await request(`/v1/operations/${operationId}`)).status === 200, "Operation could not be read");
  const environmentResponse = await request(`/v1/environments/${environmentId}`);
  const environmentText = await environmentResponse.text();
  assert(environmentResponse.status === 200 && !environmentText.includes(`secret-${suffix}`), "Environment response exposed a secret value");
  const storedSecret = await pool.query("SELECT encrypted_value FROM sandbox_environment_variables WHERE sandbox_id = $1 AND name = 'SMOKE_SECRET'", [environmentId]);
  assert(storedSecret.rows[0]?.encrypted_value && storedSecret.rows[0].encrypted_value !== `secret-${suffix}`, "Environment secret was not encrypted");
  const conflict = await request(`/v1/environments/${environmentId}/stop`, {
    method: "POST",
    headers: { "Idempotency-Key": `smoke-stop-${suffix}` },
  });
  assert(conflict.status === 409, "Conflicting lifecycle operation was accepted");
  const foreignMutation = await request(`/v1/environments/${foreignEnvironmentId}/stop`, {
    method: "POST",
    headers: { "Idempotency-Key": `smoke-foreign-${suffix}` },
  });
  assert(foreignMutation.status === 404, "Cross-organization environment was mutable");

  const mcp = await request("/mcp", {
    method: "POST",
    headers: { ...mcpHeaders, "Mcp-Method": "tools/list" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: mcpMeta } }),
  });
  assert(mcp.status === 200, `MCP tools/list returned ${mcp.status}: ${await mcp.clone().text()}`);
  const mcpText = await mcp.text();
  assert(mcpText.includes("create_environment") && mcpText.includes("delete_environment"), "MCP tool list is incomplete");

  const mcpCall = await request("/mcp", {
    method: "POST",
    headers: { ...mcpHeaders, "Mcp-Method": "tools/call", "Mcp-Name": "get_environment" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "get_environment", arguments: { environment_id: environmentId }, _meta: mcpMeta },
    }),
  });
  assert(mcpCall.status === 200, `MCP tools/call returned ${mcpCall.status}: ${await mcpCall.clone().text()}`);
  assert((await mcpCall.text()).includes(environmentId), "MCP get_environment omitted the environment");

  const mcpCreateName = `mcp-${suffix.slice(0, 8)}`;
  const mcpCreate = await request("/mcp", {
    method: "POST",
    headers: { ...mcpHeaders, "Mcp-Method": "tools/call", "Mcp-Name": "create_environment" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "create_environment",
        _meta: mcpMeta,
        arguments: {
          idempotency_key: `smoke-mcp-create-${suffix}`,
          name: mcpCreateName,
          source_type: "image",
          image: "debian:bookworm-slim",
        },
      },
    }),
  });
  assert(mcpCreate.status === 200, `MCP create_environment returned ${mcpCreate.status}`);
  const mcpCreateText = await mcpCreate.text();
  assert(mcpCreateText.includes("environment_id") && mcpCreateText.includes("operation_id"), "MCP create_environment omitted resource IDs");
  const mcpCreatedCount = await pool.query(
    "SELECT count(*)::int AS count FROM sandboxes WHERE organization_id = $1 AND name = $2",
    [organizationId, mcpCreateName],
  );
  assert(mcpCreatedCount.rows[0]?.count === 1, "MCP create_environment did not create exactly one environment");

  await pool.query("UPDATE api_keys SET scopes = ARRAY['read'] WHERE id = $1", [keyId]);
  const forbidden = await request("/v1/environments", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": `smoke-forbidden-${suffix}` },
    body: createBody,
  });
  assert(forbidden.status === 403, "Read-only key could mutate environments");
  const readOnlyMcp = await request("/mcp", {
    method: "POST",
    headers: { ...mcpHeaders, "Mcp-Method": "tools/list" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 4, method: "tools/list", params: { _meta: mcpMeta } }),
  });
  const readOnlyMcpText = await readOnlyMcp.text();
  assert(!readOnlyMcpText.includes("create_environment") && !readOnlyMcpText.includes("delete_environment"), "MCP exposed mutation tools to a read-only key");
  await pool.query("UPDATE api_keys SET expires_at = now() - interval '1 minute' WHERE id = $1", [keyId]);
  assert((await request("/v1/me")).status === 401, "Expired API key remained valid");
  await pool.query("UPDATE api_keys SET expires_at = NULL, revoked_at = now() WHERE id = $1", [keyId]);
  assert((await request("/v1/me")).status === 401, "Revoked API key remained valid");
  await pool.query("UPDATE api_keys SET revoked_at = NULL WHERE id = $1", [keyId]);
  await pool.query("UPDATE compute_jobs SET status = 'succeeded', updated_at = now() WHERE id = $1", [operationId]);
  await pool.query("UPDATE sandboxes SET state = 'deleted', desired_state = 'deleted', updated_at = now() WHERE id = $1", [environmentId]);
  assert((await request(`/v1/operations/${operationId}`)).status === 200, "Completed operation disappeared after environment deletion");

  console.log("Public API and MCP smoke test passed");
} finally {
  await pool.query("DELETE FROM organizations WHERE id = ANY($1::text[])", [[organizationId, otherOrganizationId]]).catch(() => undefined);
  await pool.query('DELETE FROM "user" WHERE id = $1', [userId]).catch(() => undefined);
  await pool.end();
}
