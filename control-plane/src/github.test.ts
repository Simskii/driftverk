import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";
import pg from "pg";
import { Hono } from "hono";
import type { AppEnv } from "./types.js";

test("personal GitHub connections", { skip: !process.env.CONTROL_PLANE_TEST_DATABASE_URL }, async t => {
  const admin = new pg.Client({ connectionString: process.env.CONTROL_PLANE_TEST_DATABASE_URL });
  await admin.connect();
  const schema = `qa_github_${crypto.randomUUID().replaceAll("-", "")}`;
  const url = new URL(process.env.CONTROL_PLANE_TEST_DATABASE_URL!);
  url.searchParams.set("options", `-c search_path=${schema}`);
  Object.assign(process.env, {
    DATABASE_URL: url.toString(), BETTER_AUTH_URL: "http://localhost:3098",
    BETTER_AUTH_SECRET: "local-test-auth-secret-000000000000", SECRET_ENCRYPTION_KEYS: "test=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    PREVIEW_TOKEN_SECRET: "local-test-preview-secret-000000000", TERMINAL_TOKEN_SECRET: "local-test-terminal-secret-000000000",
    SSH_TOKEN_SECRET: "local-test-ssh-secret-00000000000000", COMPUTE_AGENT_TOKEN: "local-test-compute-secret-000000000",
    GITHUB_APP_CLIENT_ID: "local-test", GITHUB_APP_CLIENT_SECRET: "local-test", GITHUB_APP_SLUG: "local-test",
  });
  await admin.query(`CREATE SCHEMA ${schema}; SET search_path TO ${schema}`);
  const { db } = await import("./db.js");
  try {
    const migrations = new URL("../migrations/", import.meta.url);
    for (const name of (await readdir(migrations)).filter(name => name.endsWith(".sql")).sort()) {
      await admin.query(await readFile(new URL(name, migrations), "utf8"));
      if (name === "0030_autostop_jobs.sql") {
        await admin.query(`INSERT INTO "user"(id,name,email,"emailVerified") VALUES ('alice','Alice','alice@example.test',true),('bob','Bob','bob@example.test',true);
          INSERT INTO organizations(id,name,slug) VALUES ('org','Team','team'),('other','Other','other');
          INSERT INTO memberships(id,organization_id,user_id,role) VALUES ('a','org','alice','admin'),('b','org','bob','member'),('c','other','bob','member');
          INSERT INTO workspace_github_connections(organization_id,login,encrypted_token,iv) VALUES ('org','legacy','untouched','untouched');`);
      }
    }
    const github = await import("./github.js");
    const app = new Hono<AppEnv>();
    app.use("*", async (c, next) => {
      c.set("authSession", { user: { id: c.req.header("test-user") || "bob" }, session: { activeOrganizationId: "org" } } as AppEnv["Variables"]["authSession"]);
      await next();
    });
    app.get("/connection", github.githubConnection);
    app.put("/connection", github.githubConnection);
    app.delete("/connection", github.githubConnection);
    app.get("/connect", github.githubConnect);
    app.get("/callback", github.githubCallback);
    app.get("/repositories", github.githubRepositories);
    app.get("/project-setup", github.githubProjectSetup);
    const request = (path: string, user = "bob", method = "GET", body?: unknown) => app.request(path, {
      method, headers: { "test-user": user, "content-type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const path = String(input);
      if (path.includes("/login/oauth/access_token")) return Response.json({ access_token: "bob-oauth", refresh_token: "bob-refresh", expires_in: 3600 });
      const token = new Headers(init?.headers).get("authorization")?.replace("Bearer ", "") || "";
      if (path.endsWith("/user")) return Response.json({ login: token.split("-")[0] });
      if (path.includes("/user/repos")) return Response.json([{ full_name: `${token.split("-")[0]}/private`, default_branch: "main", private: true, disabled: false }]);
      if (path.includes("/contents/")) return Response.json([]);
      throw new Error(`Unexpected GitHub request: ${path}`);
    });
    await t.test("legacy workspace connections are preserved but never used", async () => {
      assert.equal((await (await request("/connection")).json()).connection, null);
      assert.equal(await github.githubToken("bob", "org"), null);
      assert.equal((await admin.query("SELECT login FROM workspace_github_connections")).rows[0].login, "legacy");
    });
    await t.test("members connect independently across workspaces", async () => {
      for (const user of ["alice", "bob"]) assert.equal((await request("/connection", user, "PUT", { token: `${user}-token`, user_id: "alice" })).status, 200);
      assert.equal((await (await request("/connection")).json()).connection.login, "bob");
      assert.equal((await (await request("/connection", "alice")).json()).connection.login, "alice");
      assert.equal(await github.githubToken("bob", "other"), "bob-token");
      assert.equal(await github.githubToken("alice", "other"), null);
      assert.equal((await (await request("/repositories")).json()).repositories[0].full_name, "bob/private");
      assert.equal((await request("/project-setup?repository=bob/private")).status, 200);
    });
    await t.test("member OAuth binds state to its user and prevents replay", async () => {
      const start = await request("/connect");
      assert.equal(start.status, 302);
      const state = new URL(start.headers.get("location")!).searchParams.get("state");
      const callback = `/callback?state=${state}&code=local-test`;
      assert.match((await request(callback, "alice")).headers.get("location")!, /failed/);
      assert.match((await request(callback)).headers.get("location")!, /connected/);
      assert.equal(await github.githubToken("bob", "org"), "bob-oauth");
      assert.equal(await github.githubToken("alice", "org"), "alice-token");
      assert.match((await request(callback)).headers.get("location")!, /failed/);
    });
    await t.test("refresh and replacement affect only the owner", async () => {
      await admin.query("UPDATE user_github_connections SET token_expires_at=now() WHERE user_id='bob'");
      assert.equal(await github.githubToken("bob", "org"), "bob-oauth");
      assert.equal((await request("/connection", "bob", "PUT", { token: "bob-new" })).status, 200);
      const row = (await admin.query("SELECT * FROM user_github_connections WHERE user_id='bob'")).rows[0];
      assert.equal(row.refresh_token_encrypted, null);
      assert.equal(row.connection_type, "legacy_token");
      assert.equal(await github.githubToken("alice", "org"), "alice-token");
    });
    await t.test("disconnect is personal and revoked members cannot supply clone tokens", async () => {
      assert.equal((await request("/connection", "bob", "DELETE")).status, 200);
      assert.equal(await github.githubToken("bob", "org"), null);
      assert.equal(await github.githubToken("alice", "org"), "alice-token");
      await request("/connection", "bob", "PUT", { token: "bob-token" });
      const start = await request("/connect");
      const state = new URL(start.headers.get("location")!).searchParams.get("state");
      await admin.query("DELETE FROM memberships WHERE user_id='bob' AND organization_id='org'");
      assert.equal(await github.githubToken("bob", "org"), null);
      assert.equal((await request("/connection")).status, 403);
      assert.match((await request(`/callback?state=${state}&code=local-test`)).headers.get("location")!, /failed/);
    });
  } finally {
    await db.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
});
