import { TERMS_VERSION } from "./legal.js";
import assert from "node:assert/strict";
import test from "node:test";
import { readFile, readdir } from "node:fs/promises";
import pg from "pg";

test("hybrid onboarding, populated upgrade, host isolation and concurrent placement", { skip: !process.env.CONTROL_PLANE_TEST_DATABASE_URL }, async (t) => {
  const admin = new pg.Client({ connectionString: process.env.CONTROL_PLANE_TEST_DATABASE_URL });
  await admin.connect();
  const schema = `qa_hybrid_${crypto.randomUUID().replaceAll("-", "")}`;
  const url = new URL(process.env.CONTROL_PLANE_TEST_DATABASE_URL!);
  url.searchParams.set("options", `-c search_path=${schema}`);
  Object.assign(process.env, {
    DATABASE_URL: url.toString(), BETTER_AUTH_URL: "http://localhost:3098", TRUSTED_ORIGINS: "http://localhost:3098",
    BETTER_AUTH_SECRET: "local-test-auth-secret-000000000000", SECRET_ENCRYPTION_KEYS: "test=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    PREVIEW_TOKEN_SECRET: "local-test-preview-secret-000000000", TERMINAL_TOKEN_SECRET: "local-test-terminal-secret-000000000",
    SSH_TOKEN_SECRET: "local-test-ssh-secret-00000000000000", COMPUTE_AGENT_TOKEN: "local-test-compute-secret-000000000",
    AUTH_ALLOW_SIGN_UP: "true", AUTH_REQUIRE_EMAIL_VERIFICATION: "false", EMAIL_MODE: "console",
  });
  await admin.query(`CREATE SCHEMA ${schema}; SET search_path TO ${schema}`);
  const { db } = await import("./db.js");
  try {
    const migrations = new URL("../migrations/", import.meta.url);
    for (const name of (await readdir(migrations)).filter(name => name.endsWith(".sql") && name < "0022").sort())
      await admin.query(await readFile(new URL(name, migrations), "utf8"));
    await admin.query("INSERT INTO organizations (id, name, slug, hosting_mode) VALUES ('legacy', 'Legacy', 'legacy', 'hybrid')");
    await admin.query("INSERT INTO compute_agents (id, organization_id, name, token_hash) VALUES ('agent_legacy', 'legacy', 'Existing host', 'legacy-hash')");
    await assert.rejects(admin.query("INSERT INTO compute_agents (id, organization_id, name, token_hash) VALUES ('agent_second', 'legacy', 'Second', 'second-hash')"), { code: "23505" });
    await admin.query(await readFile(new URL("0022_multi_host.sql", migrations), "utf8"));
    await admin.query(await readFile(new URL("0023_project_readiness.sql", migrations), "utf8"));
    await admin.query(await readFile(new URL("0024_prebuilds_and_executions.sql", migrations), "utf8"));
    await admin.query(await readFile(new URL("0025_preview_and_github_app.sql", migrations), "utf8"));
    await admin.query(await readFile(new URL("0026_billing.sql", migrations), "utf8"));
    await admin.query(await readFile(new URL("0027_public_billing_prices.sql", migrations), "utf8"));
    await admin.query(await readFile(new URL("0029_compute_health.sql", migrations), "utf8"));
    await admin.query(await readFile(new URL("0033_terms_acceptance.sql", migrations), "utf8"));
    await admin.query(await readFile(new URL("0037_snapshot_launch_configuration.sql", migrations), "utf8"));
    await admin.query(await readFile(new URL("0039_application_status.sql", migrations), "utf8"));
    await admin.query(await readFile(new URL("0040_organization_secrets.sql", migrations), "utf8"));
    await admin.query(await readFile(new URL("0043_environment_access.sql", migrations), "utf8"));
    await admin.query(await readFile(new URL("0047_agent_profiles.sql", migrations), "utf8"));
    await admin.query("INSERT INTO billing_exchange_rates(rate_date,usd_per_sek) VALUES(current_date,0.1)");
    await admin.query("INSERT INTO compute_agents (id, organization_id, name, token_hash) VALUES ('agent_second', 'legacy', 'Second', 'second-hash')");
    assert.equal((await admin.query("SELECT name FROM compute_agents WHERE id = 'agent_legacy'")).rows[0].name, "Existing host");
    const { Hono } = await import("hono");
    const app = new Hono<import("./types.js").AppEnv>();
    const { auth } = await import("./auth.js");
    await auth.$context;
    const { listHosts, updateHosting, removeHost } = await import("./hosts.js");
    const { createEnvironment } = await import("./workspace.js");
    const setup = await import("./compute-agent-setup.js");
    const { registerComputeRoutes } = await import("./compute.js");
    app.use("*", async (c, next) => {
      const session = await auth.api.getSession({ headers: c.req.raw.headers });
      if (session) c.set("authSession", session as import("./types.js").AuthSession);
      await next();
    });
    app.all("/api/auth/*", c => auth.handler(c.req.raw));
    app.get("/api/hosts", listHosts);
    app.put("/api/hosts/hosting", updateHosting);
    app.delete("/api/hosts/:id", removeHost);
    app.post("/api/environments", c => createEnvironment(c, c.get("authSession")));
    app.post("/api/compute-agent-setup/start", setup.startComputeAgentSetup);
    app.post("/api/compute-agent-setup/poll", setup.pollComputeAgentSetup);
    app.get("/api/compute-agent-setup", c => setup.getComputeAgentSetup(c, c.get("authSession")));
    app.post("/api/compute-agent-setup/approve", c => setup.approveComputeAgentSetup(c, c.get("authSession")));
    registerComputeRoutes(app);
    async function request(path: string, body?: unknown, cookie = "", token = "", method = body === undefined ? "GET" : "POST") {
      return app.request(`http://localhost:3098${path}`, { method, headers: {
        origin: "http://localhost:3098", "content-type": "application/json", cookie,
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    }
    async function account(name: string, mode: string) {
      const signUp = await request("/api/auth/sign-up/email", { name, email: `${name}@example.test`, password: "Local-test-only-setup-123!", acceptedTerms: true, acceptedTermsVersion: TERMS_VERSION });
      assert.equal(signUp.status, 200, await signUp.clone().text());
      const cookie = signUp.headers.getSetCookie().map(value => value.split(";")[0]).join("; ");
      await admin.query('UPDATE "user" SET "emailVerified"=true WHERE email=$1', [`${name}@example.test`]);
      const result = await request("/api/auth/organization/create", { name, slug: name, hostingMode: mode }, cookie);
      assert.equal(result.status, 200, await result.clone().text());
      const org = await result.json() as { id: string; hostingMode: string };
      assert.equal(org.hostingMode, mode);
      await admin.query("UPDATE billing_accounts SET complimentary=true WHERE organization_id=$1", [org.id]);
      return { cookie, id: org.id };
    }
    const first = await account("hybrid-one", "hybrid");
    const other = await account("hybrid-two", "hybrid");
    const cloud = await account("cloud-one", "managed");
    const noHost = await request("/api/environments", { image: "nginx:alpine" }, first.cookie);
    assert.equal(noHost.status, 400);
    async function enroll(name: string, cookie: string) {
      const start = await (await request("/api/compute-agent-setup/start", { name })).json() as { user_code: string; device_code: string };
      assert.equal((await request("/api/compute-agent-setup/approve", { code: start.user_code }, cookie)).status, 200);
      const response = await request("/api/compute-agent-setup/poll", { device_code: start.device_code });
      assert.equal(response.status, 200, await response.clone().text());
      assert.equal((await request("/api/compute-agent-setup/poll", { device_code: start.device_code })).status, 409);
      const foreign = await request(`/api/compute-agent-setup?code=${start.user_code}`, undefined, other.cookie);
      assert.equal(foreign.status, 403);
      return await response.json() as { compute_node_id: string; compute_agent_token: string };
    }
    const [a, b] = await Promise.all([enroll("Host A", first.cookie), enroll("Host B", first.cookie)]);
    const listed = await (await request("/api/hosts", undefined, first.cookie)).json() as { hosts: unknown[] };
    assert.equal(listed.hosts.length, 2);
    assert.equal((await request("/api/hosts/hosting", { hosting_mode: "managed" }, first.cookie, "", "PUT")).status, 409);
    assert.equal((await request("/api/auth/organization/update", { organizationId: first.id, data: { hostingMode: "managed" } }, first.cookie)).status, 400);
    assert.equal((await request(`/api/hosts/${a.compute_node_id}`, undefined, other.cookie, "", "DELETE")).status, 404);
    assert.equal((await request("/api/environments", { image: "nginx:alpine", compute_node_id: a.compute_node_id }, other.cookie)).status, 400);
    assert.equal((await request("/api/environments", { image: "nginx:alpine", compute_node_id: a.compute_node_id }, cloud.cookie)).status, 400);
    async function create(host?: string, commands: Record<string, string | number> = {}) {
      const response = await request("/api/environments", { image: "nginx:alpine", compute_node_id: host, ...commands }, first.cookie);
      assert.equal(response.status, 202, await response.clone().text());
      return await response.json() as { id: string };
    }
    async function claim(host: typeof a, capacity?: { cpu_count: number; memory_mb: number }) {
      return request("/api/compute/jobs/claim", { node_id: host.compute_node_id, storage_driver: "local", capabilities: ["development-setup-v1", "project-readiness-v1"], capacity }, "", host.compute_agent_token);
    }
    const pinned = await create(a.compute_node_id, { memory_mb: 1024, startup_command: "npm run dev", readiness_command: "curl -f localhost:3000" });
    const unhealthy = { checks: [{ service: 'sysbox-fs', status: 'unhealthy', message: 'Service unavailable' }] };
    assert.equal((await request('/api/compute/health', { node_id: b.compute_node_id, health: unhealthy }, '', a.compute_agent_token)).status, 403);
    assert.equal((await request('/api/compute/health', { node_id: a.compute_node_id, health: unhealthy }, '', a.compute_agent_token)).status, 200);
    assert.equal((await claim(a)).status, 204, 'unhealthy host cannot lease queued work');
    const healthHosts = await (await request('/api/hosts', undefined, first.cookie)).json();
    assert.equal(healthHosts.hosts.find((host: { id: string }) => host.id === a.compute_node_id).health.status, 'unhealthy');
    assert.equal((await request('/api/compute/health', { node_id: a.compute_node_id, health: { checks: [{ service: 'sysbox-fs', status: 'healthy' }] } }, '', a.compute_agent_token)).status, 200);
    await admin.query("UPDATE compute_agents SET health_checked_at=now()-interval '2 minutes' WHERE id=$1", [a.compute_node_id]);
    assert.equal((await claim(a)).status, 204, 'stale health cannot lease queued work');
    await admin.query('UPDATE compute_agents SET health_checked_at=now() WHERE id=$1', [a.compute_node_id]);
    assert.equal((await request("/api/compute/jobs/claim", { node_id: a.compute_node_id, capabilities: ["development-setup-v1"] }, "", a.compute_agent_token)).status, 204, "old agent must not bypass app readiness");
    assert.equal((await claim(b)).status, 204);
    const claimed = await claim(a);
    assert.equal(claimed.status, 200, await claimed.clone().text());
    const claimedPayload = await claimed.json() as { sandbox: { id: string; resources: { memory_mb: number }; development: { startup_command: string; readiness_command: string; workspace_path: string } } };
    assert.equal(claimedPayload.sandbox.id, pinned.id);
    assert.equal(claimedPayload.sandbox.resources.memory_mb, 1024, "runtime receives the full limit, not the scheduling reservation");
    assert.equal(claimedPayload.sandbox.development.startup_command, "npm run dev");
    assert.equal(claimedPayload.sandbox.development.readiness_command, "curl -f localhost:3000");
    assert.equal(claimedPayload.sandbox.development.workspace_path, "/workspace");
    assert.equal((await request(`/api/hosts/${a.compute_node_id}`, undefined, first.cookie, "", "DELETE")).status, 409);
    await create();
    const attempts = await Promise.all([claim(a), claim(b)]);
    assert.deepEqual(attempts.map(response => response.status).sort(), [200, 204]);
    const limited = await enroll("Limited host", first.cookie);
    await create(undefined, { cpu: 2, memory_mb: 4096 }); await create(undefined, { cpu: 2, memory_mb: 4096 });
    const reservations = await Promise.all([claim(limited, { cpu_count: 2, memory_mb: 4096 }), claim(limited, { cpu_count: 2, memory_mb: 4096 })]);
    assert.deepEqual(reservations.map(response => response.status).sort(), [200, 204], "simultaneous claims cannot overbook one Hybrid host");
    await admin.query(`INSERT INTO workspace_snapshots (id, organization_id, name, version, status, base_image, source_sandbox_id, artifact_ref, created_by_user_id)
      SELECT 'local-snapshot', organization_id, 'Local', '1', 'ready', 'nginx:alpine', id, 'driftverk/local:latest', created_by_user_id FROM sandboxes WHERE id = $1`, [pinned.id]);
    const wrongSnapshotHost = await request("/api/environments", { source_type: "snapshot", snapshot_id: "local-snapshot", compute_node_id: b.compute_node_id }, first.cookie);
    assert.equal(wrongSnapshotHost.status, 400);
    const localRestore = await request("/api/environments", { source_type: "snapshot", snapshot_id: "local-snapshot" }, first.cookie);
    assert.equal(localRestore.status, 202);
    const restored = await localRestore.json() as { id: string };
    assert.equal((await admin.query("SELECT compute_node_id FROM sandboxes WHERE id = $1", [restored.id])).rows[0].compute_node_id, a.compute_node_id);
    await admin.query(`INSERT INTO workspace_volumes (id, organization_id, name, storage_prefix, created_by_user_id, compute_node_id)
      SELECT 'vol_00000000-0000-0000-0000-000000000001', organization_id, 'vol_00000000-0000-0000-0000-000000000001', 'volumes/a', created_by_user_id, compute_node_id FROM sandboxes WHERE id = $1`, [pinned.id]);
    assert.equal((await request("/api/environments", { image: "nginx:alpine", compute_node_id: b.compute_node_id, volume_mounts: [{ volume_id: "vol_00000000-0000-0000-0000-000000000001", mount_path: "/data", read_only: true }] }, first.cookie)).status, 400);
    await admin.query("UPDATE workspace_volumes SET compute_node_id = NULL WHERE id = 'vol_00000000-0000-0000-0000-000000000001'");
    assert.equal((await request("/api/environments", { image: "nginx:alpine", compute_node_id: a.compute_node_id, volume_mounts: [{ volume_id: "vol_00000000-0000-0000-0000-000000000001", mount_path: "/data", read_only: true }] }, first.cookie)).status, 202);
    assert.equal((await request("/api/environments", { image: "nginx:alpine", compute_node_id: b.compute_node_id, volume_mounts: [{ volume_id: "vol_00000000-0000-0000-0000-000000000001", mount_path: "/data", read_only: true }] }, first.cookie)).status, 400, "explicit placement reserves a new volume before either job is claimed");
    // A member can inspect hosts but cannot change infrastructure.
    await admin.query("UPDATE memberships SET role = 'member' WHERE organization_id = $1", [first.id]);
    assert.equal((await request("/api/hosts/hosting", { hosting_mode: "hybrid" }, first.cookie, "", "PUT")).status, 403);
    assert.equal((await request(`/api/hosts/${b.compute_node_id}`, undefined, first.cookie, "", "DELETE")).status, 403);
    const anotherOrganization = await request("/api/auth/organization/create", { name: "Another", slug: "another", hostingMode: "managed" }, first.cookie);
    assert.equal(anotherOrganization.status, 200);
    const activeHosts = await (await request("/api/hosts", undefined, first.cookie)).json() as { hosting_mode: string; hosts: unknown[] };
    assert.equal(activeHosts.hosting_mode, "managed", "new organization becomes the active workspace");
    assert.equal(activeHosts.hosts.length, 0, "hosts from the previous organization are not exposed");
  } catch (error) {
    console.error(error);
    throw error;
  } finally {
    await db.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
});
