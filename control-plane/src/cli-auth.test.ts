import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";
import { serializeSignedCookie } from "better-call";

test("CLI device approval and session revocation", { skip: !process.env.CONTROL_PLANE_TEST_DATABASE_URL }, async () => {
  const admin = new pg.Client({ connectionString: process.env.CONTROL_PLANE_TEST_DATABASE_URL });
  await admin.connect();
  const schema = `qa_cli_${crypto.randomUUID().replaceAll("-", "")}`;
  const url = new URL(process.env.CONTROL_PLANE_TEST_DATABASE_URL!);
  url.searchParams.set("options", `-c search_path=${schema}`);
  Object.assign(process.env, {
    NODE_ENV: "development", DATABASE_URL: url.toString(),
    BETTER_AUTH_URL: "http://localhost:3098", TRUSTED_ORIGINS: "http://localhost:3098",
    BETTER_AUTH_SECRET: "local-test-auth-secret-000000000000", SECRET_ENCRYPTION_KEYS: "test=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    PREVIEW_TOKEN_SECRET: "local-test-preview-secret-000000000", TERMINAL_TOKEN_SECRET: "local-test-terminal-secret-000000000",
    SSH_TOKEN_SECRET: "local-test-ssh-secret-00000000000000", COMPUTE_AGENT_TOKEN: "local-test-compute-secret-000000000",
    AUTH_ALLOW_SIGN_UP: "true", AUTH_REQUIRE_EMAIL_VERIFICATION: "true", EMAIL_MODE: "console",
  });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const { db } = await import("./db.js");
  try {
    const { migrate } = await import("./migrate.js");
    await migrate();
    const { auth } = await import("./auth.js");
    await db.query(`INSERT INTO "user" (id,name,email,"emailVerified") VALUES
      ('verified','Verified','verified@cli.test',true),('unverified','Unverified','unverified@cli.test',false),
      ('other','Other','other@cli.test',true);
      INSERT INTO "session" (id,token,"userId","expiresAt","updatedAt") VALUES
      ('verified-session','verified-token','verified',now()+interval '1 day',now()),
      ('unverified-session','unverified-token','unverified',now()+interval '1 day',now()),
      ('other-session','other-token','other',now()+interval '1 day',now());`);
    async function request(path: string, body?: unknown, token = "") {
      const credential = path.startsWith("/device/") && token
        ? { cookie: await serializeSignedCookie("better-auth.session_token", token, process.env.BETTER_AUTH_SECRET!) }
        : token ? { authorization: `Bearer ${token}` } : {};
      return auth.handler(new Request(`http://localhost:3098/api/auth${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: { origin: "http://localhost:3098", "content-type": "application/json", ...credential } as HeadersInit,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }));
    }
    async function issue() {
      const response = await request("/device/code", { client_id: "driftverk-cli" });
      assert.equal(response.status, 200);
      const code = await response.json();
      assert.equal(new URL(code.verification_uri).pathname, "/cli");
      assert.equal(code.expires_in, 600);
      return code;
    }
    const redeem = (code: { device_code: string }, clientId = "driftverk-cli") => request("/device/token", {
      client_id: clientId, device_code: code.device_code, grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    });
    assert.ok(await (await request("/get-session", undefined, "verified-token")).json(), "seeded bearer session is readable");
    assert.equal((await request("/device/code", { client_id: "unknown" })).status, 400);
    const code = await issue();
    assert.equal((await (await redeem(code)).json()).error, "authorization_pending");
    assert.equal((await (await redeem(code)).json()).error, "slow_down");
    assert.equal((await request("/device/approve", { userCode: code.user_code })).status, 401);
    assert.equal((await request("/device/approve", { userCode: code.user_code }, "unverified-token")).status, 403);
    await request(`/device?user_code=${code.user_code}`, undefined, "verified-token");
    assert.equal((await request("/device/approve", { userCode: code.user_code }, "other-token")).status, 403);
    assert.equal((await request("/device/approve", { userCode: code.user_code }, "verified-token")).status, 200);
    assert.equal((await redeem(code, "unknown")).status, 400);
    await db.query('UPDATE "deviceCode" SET "lastPolledAt"=now()-interval \'1 minute\'');
    const approved = await redeem(code);
    assert.equal(approved.status, 200);
    const { access_token: token } = await approved.json();
    const session = await (await request("/get-session", undefined, token)).json();
    assert.equal(session.user.id, "verified");
    assert.notEqual(session.session.id, "verified-session");
    const created = await request("/organization/create", { name: "Verified's workspace", slug: "personal-cli-test", hostingMode: "managed" }, token);
    assert.equal(created.status, 200);
    const organization = await created.json();
    assert.equal((await request("/organization/set-active", { organizationId: organization.id }, token)).status, 200);
    const selected = await (await request("/get-session", undefined, token)).json();
    assert.equal(selected.session.activeOrganizationId, organization.id);
    assert.equal((await (await request("/organization/list", undefined, token)).json()).length, 1);
    assert.equal((await redeem(code)).status, 400);
    assert.equal((await request("/sign-out", {}, token)).status, 200);
    assert.equal(await (await request("/get-session", undefined, token)).json(), null);
    assert.ok(await (await request("/get-session", undefined, "verified-token")).json());

    const denied = await issue();
    await request(`/device?user_code=${denied.user_code}`, undefined, "verified-token");
    assert.equal((await request("/device/deny", { userCode: denied.user_code }, "verified-token")).status, 200);
    assert.equal((await (await redeem(denied)).json()).error, "access_denied");
    const expired = await issue();
    await db.query('UPDATE "deviceCode" SET "expiresAt"=now()-interval \'1 second\'');
    assert.equal((await (await redeem(expired)).json()).error, "expired_token");
    assert.equal((await request("/device/approve", { userCode: expired.user_code }, "verified-token")).status, 400);
  } finally {
    await db.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
});
