import { TERMS_VERSION } from "./legal.js";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import test from "node:test";
import pg from "pg";

test("emailed invitation authentication", { skip: !process.env.CONTROL_PLANE_TEST_DATABASE_URL }, async (t) => {
  const admin = new pg.Client({ connectionString: process.env.CONTROL_PLANE_TEST_DATABASE_URL });
  await admin.connect();
  const schema = `qa_invitation_${crypto.randomUUID().replaceAll("-", "")}`;
  const url = new URL(process.env.CONTROL_PLANE_TEST_DATABASE_URL!);
  url.searchParams.set("options", `-c search_path=${schema}`);
  Object.assign(process.env, {
    DATABASE_URL: url.toString(), BETTER_AUTH_URL: "http://localhost:3098", TRUSTED_ORIGINS: "http://localhost:3098",
    BETTER_AUTH_SECRET: "local-test-auth-secret-000000000000", SECRET_ENCRYPTION_KEYS: "test=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    PREVIEW_TOKEN_SECRET: "local-test-preview-secret-000000000", TERMINAL_TOKEN_SECRET: "local-test-terminal-secret-000000000",
    SSH_TOKEN_SECRET: "local-test-ssh-secret-00000000000000", COMPUTE_AGENT_TOKEN: "local-test-compute-secret-000000000",
    AUTH_ALLOW_SIGN_UP: "true", AUTH_REQUIRE_EMAIL_VERIFICATION: "true", EMAIL_MODE: "console",
  });
  await admin.query(`CREATE SCHEMA ${schema}; SET search_path TO ${schema}`);
  const { db } = await import("./db.js");
  const emails: { to: string; subject: string; text: string }[] = [];
  t.mock.method(console, "info", (message: string) => {
    try { const data = JSON.parse(message); if (data.event === "email_preview") emails.push(data); } catch { /* Other logs are not email. */ }
  });
  try {
    const migrations = new URL("../migrations/", import.meta.url);
    for (const name of (await readdir(migrations)).filter(name => name.endsWith(".sql")).sort()) {
      if (name === "0033_terms_acceptance.sql") {
        await admin.query(`INSERT INTO "user" (id,name,email,"emailVerified") VALUES ('legacy-terms','Legacy','legacy-terms@example.test',true)`);
      }
      await admin.query(await readFile(new URL(name, migrations), "utf8"));
    }
    await admin.query(`INSERT INTO "user" (id,name,email,"emailVerified") VALUES ('admin','Admin','admin@example.test',true);
      INSERT INTO organizations (id,name,slug) VALUES ('org','Invited team','invited-team');
      INSERT INTO memberships (id,organization_id,user_id,role) VALUES ('admin-member','org','admin','admin');`);
    const { auth } = await import("./auth.js");
    const { createInvitationToken, invitationHeader } = await import("./invitation-auth.js");
    const password = "Local-invitation-test-123!";
    const cookies = (response: Response) => response.headers.getSetCookie().map(value => value.split(";")[0]).join("; ");
    async function request(path: string, body?: unknown, token = "", cookie = "") {
      return auth.handler(new Request(`http://localhost:3098/api/auth${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: { origin: "http://localhost:3098", "content-type": "application/json", cookie,
          ...(token ? { [invitationHeader]: token } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }));
    }
    const signup = (email: string, token = "") => request("/sign-up/email", { name: "Invited user", email, password, acceptedTerms: true, acceptedTermsVersion: TERMS_VERSION }, token);
    async function invite(email: string, status = "pending", expiresAt = new Date(Date.now() + 3_600_000)) {
      const id = crypto.randomUUID();
      await admin.query("INSERT INTO invitations (id,organization_id,email,role,status,expires_at,inviter_id) VALUES ($1,'org',$2,'member',$3,$4,'admin')", [id, email, status, expiresAt]);
      return { id, token: await createInvitationToken(id, email, expiresAt) };
    }
    async function verified(email: string) {
      return (await admin.query('SELECT "emailVerified" FROM "user" WHERE email=$1', [email])).rows[0]?.emailVerified;
    }

    await t.test("signup rejects missing, false and outdated terms without creating users", async () => {
      for (const [suffix, acceptance] of [
        ["missing", {}],
        ["false", { acceptedTerms: false, acceptedTermsVersion: TERMS_VERSION }],
        ["stale", { acceptedTerms: true, acceptedTermsVersion: "old-version" }],
        ["string", { acceptedTerms: "true", acceptedTermsVersion: TERMS_VERSION }],
      ] as const) {
        const email = `terms-${suffix}@example.test`;
        const response = await request("/sign-up/email", { name: "Terms test", email, password, ...acceptance });
        assert.equal(response.status, 400, await response.clone().text());
        assert.equal((await db.query('SELECT id FROM "user" WHERE email=$1', [email])).rowCount, 0);
      }
      const invitation = await invite("terms-invited@example.test");
      const response = await request("/sign-up/email", { name: "Invited", email: "terms-invited@example.test", password }, invitation.token);
      assert.equal(response.status, 400);
      assert.equal((await db.query('SELECT id FROM "user" WHERE email=$1', ["terms-invited@example.test"])).rowCount, 0);
    });

    await t.test("ordinary signup records the server timestamp and protects acceptance fields", async () => {
      const before = Date.now();
      const response = await signup("terms-accepted@example.test");
      assert.equal(response.status, 200, await response.clone().text());
      const record = (await db.query('SELECT terms_version, terms_accepted_at FROM "user" WHERE email=$1', ["terms-accepted@example.test"])).rows[0];
      assert.equal(record.terms_version, TERMS_VERSION);
      assert.ok(record.terms_accepted_at.getTime() >= before && record.terms_accepted_at.getTime() <= Date.now());
      const forged = await request("/sign-up/email", { name: "Forged", email: "forged@example.test", password,
        acceptedTerms: true, acceptedTermsVersion: TERMS_VERSION, termsAcceptedAt: "2000-01-01T00:00:00Z" });
      assert.equal(forged.status, 400);
      const legacy = (await db.query(`SELECT terms_version, terms_accepted_at FROM "user" WHERE id='legacy-terms'`)).rows[0];
      assert.equal(legacy.terms_version, null);
      assert.equal(legacy.terms_accepted_at, null);
    });

    await t.test("signup verifies the invited address, sends no second email, and joins the active workspace", async () => {
      const invitation = await invite("invited@example.test");
      const preview = await request("/invitation-preview", undefined, invitation.token);
      assert.equal(preview.status, 200);
      assert.equal((await preview.json()).organization_name, "Invited team");
      assert.equal(preview.headers.get("cache-control"), "no-store");
      const response = await signup("INVITED@example.test", invitation.token);
      assert.equal(response.status, 200, await response.clone().text());
      assert.equal((await response.json()).user.emailVerified, true);
      assert.equal(await verified("invited@example.test"), true);
      assert.equal((await db.query('SELECT terms_version FROM "user" WHERE email=$1', ["invited@example.test"])).rows[0].terms_version, TERMS_VERSION);
      assert.equal(emails.filter(email => email.to === "invited@example.test").length, 0);
      const cookie = cookies(response);
      assert.ok(cookie);
      const accepted = await request("/organization/accept-invitation", { invitationId: invitation.id }, "", cookie);
      assert.equal(accepted.status, 200, await accepted.clone().text());
      const session = await (await request("/get-session", undefined, "", cookie)).json();
      assert.equal(session.session.activeOrganizationId, "org");
      assert.equal(session.user.emailVerified, true);
      assert.equal((await request("/invitation-preview", undefined, invitation.token)).status, 400);
      assert.equal((await signup("invited@example.test", invitation.token)).status, 400);
    });

    await t.test("ordinary signup and legacy invitation IDs still require email verification", async () => {
      const invitation = await invite("ordinary@example.test");
      const response = await signup("ordinary@example.test");
      assert.equal(response.status, 200);
      assert.equal((await response.json()).token, null);
      assert.equal(await verified("ordinary@example.test"), false);
      assert.equal(emails.filter(email => email.to === "ordinary@example.test").length, 1);
      assert.equal((await request("/sign-in/email", { email: "ordinary@example.test", password })).status, 403);
      assert.equal((await signup("ordinary@example.test", invitation.id)).status, 400);
    });

    await t.test("invalid, altered, expired, cancelled, rejected and mismatched proofs do not create accounts", async () => {
      const valid = await invite("valid@example.test");
      const badTokens = ["invalid", valid.id, `${valid.token.slice(0, -8)}AAAAAAAA`];
      for (const status of ["canceled", "rejected", "accepted"]) badTokens.push((await invite(`${status}@example.test`, status)).token);
      badTokens.push((await invite("expired@example.test", "pending", new Date(Date.now() - 60_000))).token);
      const revoked = await invite("revoked@example.test");
      await admin.query("UPDATE invitations SET expires_at=now()-interval '1 minute' WHERE id=$1", [revoked.id]);
      badTokens.push(revoked.token);
      for (const token of badTokens) assert.equal((await signup("invalid@example.test", token)).status, 400);
      assert.equal((await signup("other@example.test", valid.token)).status, 403);
      assert.equal(await verified("invalid@example.test"), undefined);
      assert.equal(await verified("other@example.test"), undefined);
    });

    await t.test("an existing unverified account must authenticate before the invitation verifies it", async () => {
      await signup("existing@example.test");
      const invitation = await invite("existing@example.test");
      assert.equal((await signup("existing@example.test", invitation.token)).status, 422);
      assert.equal((await request("/sign-in/email", { email: "existing@example.test", password: "wrong-password" }, invitation.token)).status, 401);
      assert.equal(await verified("existing@example.test"), false);
      // An invitation proof must not bypass revocation through the generic verification route.
      await request(`/verify-email?token=${encodeURIComponent(invitation.token)}`);
      assert.equal(await verified("existing@example.test"), false);
      const count = emails.length;
      const response = await request("/sign-in/email", { email: "existing@example.test", password }, invitation.token);
      assert.equal(response.status, 200, await response.clone().text());
      assert.equal(await verified("existing@example.test"), true);
      assert.equal(emails.length, count);
      assert.equal((await request("/organization/accept-invitation", { invitationId: invitation.id }, "", cookies(response))).status, 200);
    });

    await t.test("concurrent invited signup does not disable verification for ordinary signup", async () => {
      const invitation = await invite("parallel-invited@example.test");
      const [invited, ordinary] = await Promise.all([signup("parallel-invited@example.test", invitation.token), signup("parallel-ordinary@example.test")]);
      assert.equal(invited.status, 200);
      assert.equal(ordinary.status, 200);
      assert.equal(await verified("parallel-invited@example.test"), true);
      assert.equal(await verified("parallel-ordinary@example.test"), false);
      assert.equal((await ordinary.json()).token, null);
      assert.equal(auth.options.emailAndPassword?.requireEmailVerification, true);
    });

    await t.test("the invitation email includes the signed proof and a valid preview", async () => {
      const { sendOrganizationInvitationEmail } = await import("./email.js");
      const invitation = await invite("emailed@example.test");
      await sendOrganizationInvitationEmail({ email: "emailed@example.test", inviterName: "Admin", organizationName: "Invited team", invitationId: invitation.id, expiresAt: new Date(Date.now() + 3_600_000) });
      const email = emails.find(email => email.to === "emailed@example.test")!;
      const link = new URL(email.text.match(/http:\/\/\S+/)![0]);
      assert.equal(link.pathname, "/accept-invitation");
      assert.equal(link.searchParams.get("id"), invitation.id);
      const preview = await request("/invitation-preview", undefined, link.searchParams.get("token")!);
      assert.equal(preview.status, 200);
      assert.equal((await preview.json()).email, "emailed@example.test");
    });
  } finally {
    await db.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
});
