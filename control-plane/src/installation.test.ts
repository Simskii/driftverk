import assert from "node:assert/strict";
import test from "node:test";
import { readdir, readFile } from "node:fs/promises";
import pg from "pg";
import { initializeInstallation, installationMode } from "./installation.js";
import { grantPlatformAdmin } from "./admin-bootstrap.js";
import { compatibleMigrationChecksum } from "./migration-compatibility.js";
const url = process.env.CONTROL_PLANE_TEST_DATABASE_URL;

test("installation mode and migration compatibility reject unknown values", () => {
  assert.equal(installationMode(), "hosted");
  assert.equal(installationMode("self-hosted"), "self-hosted");
  assert.throws(() => installationMode("selfhosted"));
  assert.equal(compatibleMigrationChecksum("0012_platform_admin_flag.sql", "unexpected", "unexpected"), false);
  const previous = "715d15700d48762f6b6fc6240be5884ce6c7a22372052283417b38d4141c1379";
  const corrected = "301178580a25534ee3e89888a4f5ab5f20d5e7e58e7cad8338657bfd9d250f5d";
  assert.equal(compatibleMigrationChecksum("0012_platform_admin_flag.sql", previous, corrected), true);
  assert.equal(compatibleMigrationChecksum("0013_other.sql", previous, corrected), false);
  assert.equal(compatibleMigrationChecksum("0012_platform_admin_flag.sql", corrected, previous), false);
});

test("self-hosted signup, admin bootstrap and billing policies", { skip: !url }, async () => {
  const admin = new pg.Client({ connectionString: url }); await admin.connect();
  const schema = `selfhost_${crypto.randomUUID().replaceAll("-", "")}`;
  const scoped = new URL(url!); scoped.searchParams.set("options", `-c search_path=${schema}`);
  const pool = new pg.Pool({ connectionString: scoped.toString() });
  let appPool: pg.Pool | undefined;
  try {
    await admin.query(`CREATE SCHEMA ${schema}; SET search_path TO ${schema}`);
    for (const name of (await readdir(new URL("../migrations", import.meta.url))).filter(n => n.endsWith(".sql")).sort())
      await admin.query(await readFile(new URL(`../migrations/${name}`, import.meta.url), "utf8"));
    await initializeInstallation(pool, "self-hosted");
    await initializeInstallation(pool, "self-hosted");
    await assert.rejects(initializeInstallation(pool, "hosted"), /differs from this database/);
    await pool.query(`INSERT INTO "user"(id,name,email,"emailVerified") VALUES ('owner','Owner','owner@example.test',true),('pending','Pending','pending@example.test',false);
      INSERT INTO organizations(id,name,slug,hosting_mode) VALUES ('org','Org','org','managed');
      INSERT INTO memberships(id,organization_id,user_id,role) VALUES ('member','org','owner','admin');`);
    assert.equal((await pool.query("SELECT hosting_mode FROM organizations WHERE id='org'")).rows[0].hosting_mode, "hybrid");
    await pool.query("UPDATE billing_accounts SET complimentary=false WHERE organization_id='org'");
    assert.equal((await pool.query("SELECT complimentary FROM billing_accounts WHERE organization_id='org'")).rows[0].complimentary, true);
    await assert.rejects(pool.query("UPDATE organizations SET hosting_mode='managed' WHERE id='org'"), /own compute hosts/);
    for (let i=0;i<3;i++) await pool.query("INSERT INTO compute_agents(id,organization_id,name,token_hash) VALUES($1,'org',$1,$1)", [`host${i}`]);
    await pool.query(`INSERT INTO sandboxes(id,preview_id,organization_id,name,source_type,source_image,cpu_count,memory_mb,disk_gb,state,desired_state,created_by_user_id)
      VALUES('env',gen_random_uuid(),'org','env','image','alpine',1,2048,40,'provisioning','running','owner');
      SELECT billing_assert('org','env'); SELECT billing_access('org','env',false); SELECT billing_access('org','env',true);
      UPDATE sandboxes SET runtime_id='runtime',billing_compute_active=true WHERE id='env'; SELECT billing_settle('org');`);
    assert.equal((await pool.query("SELECT count(*)::int AS count FROM billing_ledger")).rows[0].count, 0);
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM "user" WHERE is_platform_admin')).rows[0].count, 0);
    await assert.rejects(grantPlatformAdmin(pool, "missing@example.test"), /verified account/);
    await assert.rejects(grantPlatformAdmin(pool, "pending@example.test"), /verified account/);
    assert.equal(await grantPlatformAdmin(pool, "OWNER@example.test"), "owner");
    Object.assign(process.env, { INSTALLATION_MODE: "self-hosted", DATABASE_URL: scoped.toString(), BETTER_AUTH_URL: "http://localhost:3097",
      BETTER_AUTH_SECRET: "a".repeat(32), SECRET_ENCRYPTION_KEYS: "test=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
      PREVIEW_TOKEN_SECRET: "p".repeat(32), TERMINAL_TOKEN_SECRET: "t".repeat(32), SSH_TOKEN_SECRET: "s".repeat(32),
      COMPUTE_AGENT_TOKEN: "c".repeat(32), AUTH_REQUIRE_EMAIL_VERIFICATION: "false", EMAIL_MODE: "console", SIGNUP_NOTIFICATION_EMAIL: "" });
    const { db } = await import("./db.js"); appPool = db;
    const { config } = await import("./config.js");
    assert.equal(config.signupNotificationEmail, ""); assert.equal(config.termsVersion, null);
    const { sendSignupNotificationEmail } = await import("./email.js");
    const { auth } = await import("./auth.js");
    const messages: string[] = []; const original = console.info; let response: Response;
    try {
      console.info = (...args: unknown[]) => { messages.push(args.map(String).join(" ")); };
      await sendSignupNotificationEmail({ userId: "owner", email: "owner@example.test", name: "Owner", createdAt: new Date() });
      assert.equal(messages.length, 0);
      config.signupNotificationEmail = "operator@example.test";
      await sendSignupNotificationEmail({ userId: "owner", email: "owner@example.test", name: "Owner", createdAt: new Date() });
      assert.ok(messages.some(message => message.includes("operator@example.test")));
      config.signupNotificationEmail = "";
      response = await auth.handler(new Request("http://localhost:3097/api/auth/sign-up/email", { method: "POST", headers: { "Content-Type": "application/json", Origin: "http://localhost:3097" }, body: JSON.stringify({ name: "New user", email: "new@example.test", password: "local-test-password-123" }) }));
    } finally { console.info = original; }
    assert.equal(response!.status, 200);
    const signedUp = (await pool.query('SELECT terms_version,is_platform_admin FROM "user" WHERE email=$1', ["new@example.test"])).rows[0];
    assert.equal(signedUp.terms_version, null); assert.equal(signedUp.is_platform_admin, false);
    const { reconcileBilling, reconcileCheckouts, stripeWebhook } = await import("./billing.js");
    await reconcileBilling(); await reconcileCheckouts();
    const { Hono } = await import("hono"); const webhook = new Hono<import("./types.js").AppEnv>(); webhook.post("/webhook", stripeWebhook);
    assert.equal((await webhook.request("/webhook", { method: "POST" })).status, 404);
  } finally { await appPool?.end(); await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); }
});

test("existing organizations cannot silently switch installation modes", { skip: !url }, async () => {
  const admin = new pg.Client({ connectionString: url }); await admin.connect();
  const schema = `mode_guard_${crypto.randomUUID().replaceAll("-", "")}`;
  const scoped = new URL(url!); scoped.searchParams.set("options", `-c search_path=${schema}`);
  const pool = new pg.Pool({ connectionString: scoped.toString() });
  try {
    await admin.query(`CREATE SCHEMA ${schema}; SET search_path TO ${schema}; CREATE TABLE organizations(id text); CREATE TABLE installation_settings(singleton boolean PRIMARY KEY,mode text); INSERT INTO organizations VALUES('existing')`);
    await assert.rejects(initializeInstallation(pool, "self-hosted"), /new database/);
    await initializeInstallation(pool, "hosted");
    await assert.rejects(initializeInstallation(pool, "self-hosted"), /differs from this database/);
  } finally { await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); }
});
