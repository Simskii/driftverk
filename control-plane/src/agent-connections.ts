import type { Context } from "hono";
import { db } from "./db.js";
import { config } from "./config.js";
import { encryptSecret, decryptSecret, secretContext } from "./secrets.js";
import { openCodexAuth, parseCodexCredentials, needsRefresh, refreshCodexCredentials } from "./codex-auth.js";
import { createTerminalToken, verifyTerminalToken, type TerminalGrant } from "./terminal-token.js";
import { parseAgentModel } from "./agent-config.js";
import type { AppEnv } from "./types.js";

const activeLogins = new Map<string, () => Promise<void>>();
type Connection = { id: string; user_id: string; encrypted_value: string; iv: string; generation: string };
type CredentialGrant = TerminalGrant & { connectionId: string; runtimeId: string; accountId: string; generation: string };
const credentialSecret = () => `${config.terminalTokenSecret}:codex-credential-v1`;

export function signAgentCredentialGrant(grant: CredentialGrant) { return createTerminalToken(grant, credentialSecret()); }
export function readAgentCredentialGrant(token: string): CredentialGrant | null {
  const grant = verifyTerminalToken(token, credentialSecret()) as CredentialGrant | null;
  return grant && typeof grant.userId === "string" && typeof grant.connectionId === "string" && typeof grant.runtimeId === "string" && typeof grant.accountId === "string" && typeof grant.generation === "string" ? grant : null;
}

// All callers take the same row lock. Only the server holds the refresh token,
// so concurrent environments cannot race a rotating provider refresh token.
export async function connectionCredentials(connectionId: string, userId: string) {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const row = (await client.query<Connection>("SELECT * FROM user_agent_connections WHERE id=$1 AND user_id=$2 AND encrypted_value IS NOT NULL FOR UPDATE", [connectionId, userId])).rows[0];
    if (!row) throw new Error("Reconnect ChatGPT in Agents");
    const context = secretContext.agentConnection(userId);
    let credentials = parseCodexCredentials(decryptSecret(row.encrypted_value, row.iv, context));
    if (needsRefresh(credentials)) {
      credentials = await refreshCodexCredentials(credentials);
      const encrypted = encryptSecret(JSON.stringify(credentials), context);
      await client.query("UPDATE user_agent_connections SET encrypted_value=$2,iv=$3 WHERE id=$1", [row.id, encrypted.encryptedValue, encrypted.iv]);
    }
    await client.query("COMMIT");
    return { accessToken: credentials.tokens.access_token, accountId: credentials.tokens.account_id, generation: row.generation };
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
}

export async function agentConnection(c: Context<AppEnv>) {
  c.header("Cache-Control", "no-store");
  const userId = c.get("authSession").user.id;
  if (c.req.method === "GET") {
    const login = (await db.query("SELECT id,status,expires_at FROM user_agent_logins WHERE user_id=$1", [userId])).rows[0];
    return c.json({ status: login?.status === "pending" && new Date(login.expires_at).getTime() <= Date.now() ? "expired" : login?.status || "idle" });
  }
  if (c.req.method === "DELETE") {
    // Deleting the attempt first fences late completion on any server instance.
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      await client.query('SELECT id FROM "user" WHERE id=$1 FOR UPDATE', [userId]);
      await client.query("DELETE FROM user_agent_logins WHERE user_id=$1", [userId]);
      await client.query("UPDATE user_agent_connections SET encrypted_value=NULL,iv=NULL,generation=gen_random_uuid()::text WHERE user_id=$1 AND agent_id='codex'", [userId]);
      await client.query("COMMIT");
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
    await activeLogins.get(userId)?.();
    return c.json({ connected: false });
  }
  if (c.req.method === "PUT") {
    const input = await c.req.json().catch(() => null);
    if (!input || typeof input.is_default !== "boolean") return c.json({ error: "Choose a default preference" }, 400);
    let model: string | null;
    try { model = parseAgentModel(input.model); } catch { return c.json({ error: "Invalid model ID" }, 400); }
    const result = await db.query("UPDATE user_agent_connections SET is_default=$2, model=$3 WHERE user_id=$1 AND agent_id='codex' AND encrypted_value IS NOT NULL", [userId, input.is_default, model]);
    return result.rowCount ? c.json({ saved: true }) : c.json({ error: "Connect ChatGPT first" }, 409);
  }
  if (activeLogins.size >= 32 && !activeLogins.has(userId)) return c.json({ error: "Sign-in is busy. Try again shortly." }, 503);
  const attemptId = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + 10 * 60_000);
  const attempt = await db.query(`INSERT INTO user_agent_logins(user_id,id,status,expires_at) VALUES ($1,$2,'pending',$3)
    ON CONFLICT(user_id) DO UPDATE SET id=$2,status='pending',expires_at=$3,created_at=now()
    WHERE user_agent_logins.created_at < now()-interval '15 seconds' RETURNING id`, [userId, attemptId, expiresAt]);
  if (!attempt.rowCount) return c.json({ error: "Wait a few seconds before starting another sign-in." }, 429);
  await activeLogins.get(userId)?.();
  let session: Awaited<ReturnType<typeof openCodexAuth>> | undefined;
  let timer: NodeJS.Timeout | undefined;
  let closed = false;
  let completed = false;
  const close = async () => { closed = true; clearTimeout(timer); if (activeLogins.get(userId) === close) activeLogins.delete(userId); await session?.close(); };
  activeLogins.set(userId, close);
  const fail = async () => {
    await db.query("UPDATE user_agent_logins SET status='failed' WHERE user_id=$1 AND id=$2 AND status='pending'", [userId, attemptId]);
    await close();
  };
  try {
    session = await openCodexAuth();
    if (closed) { await session.close(); throw new Error("Sign-in cancelled"); }
    const auth = session;
    auth.onNotification((method, params) => {
      if (method !== "account/login/completed" || completed || closed) return;
      completed = true;
      void (async () => {
        if (!params.success) { await fail(); return; }
        const credentials = await auth.credentials();
        const encrypted = encryptSecret(JSON.stringify(credentials), secretContext.agentConnection(userId));
        const client = await db.connect();
        try {
          await client.query("BEGIN");
          await client.query('SELECT id FROM "user" WHERE id=$1 FOR UPDATE', [userId]);
          const current = await client.query("UPDATE user_agent_logins SET status='connected' WHERE user_id=$1 AND id=$2 AND status='pending' AND expires_at>now() RETURNING id", [userId, attemptId]);
          if (current.rowCount) await client.query(`INSERT INTO user_agent_connections(id,user_id,agent_id,encrypted_value,iv)
            VALUES ($1,$2,'codex',$3,$4) ON CONFLICT(user_id,agent_id) DO UPDATE SET encrypted_value=$3,iv=$4,generation=gen_random_uuid()::text`,
          [crypto.randomUUID(), userId, encrypted.encryptedValue, encrypted.iv]);
          await client.query("COMMIT");
        } catch (error) { await client.query("ROLLBACK"); throw error; }
        finally { client.release(); }
        await close();
      })().catch(() => fail().catch(() => close()));
    });
    const result = await auth.request("account/login/start", { type: "chatgptDeviceCode" });
    if (result.type !== "chatgptDeviceCode" || result.verificationUrl !== "https://auth.openai.com/codex/device" || typeof result.userCode !== "string")
      throw new Error("Unexpected sign-in response");
    if (closed) throw new Error("Sign-in cancelled");
    timer = setTimeout(() => { void fail().catch(() => close()); }, 10 * 60_000); timer.unref();
    return c.json({ user_code: result.userCode, verification_url: result.verificationUrl, expires_at: expiresAt.toISOString() });
  } catch { await fail(); return c.json({ error: "Could not start ChatGPT sign-in. Please try again." }, 502); }
}

// No browser session or organization API key can call this endpoint. Its signed
// grant authorizes only this live runtime and this user's selected connection.
export async function agentCredential(c: Context<AppEnv>) {
  c.header("Cache-Control", "no-store");
  const grant = readAgentCredentialGrant(c.req.header("authorization")?.replace(/^Bearer /, "") || "");
  if (!grant) return c.json({ error: "Reopen the agent pane to renew access" }, 401);
  const allowed = await db.query(`SELECT 1 FROM sandboxes s JOIN user_agent_connections a ON a.id=$4 AND a.user_id=$5
    WHERE s.id=$1 AND s.compute_node_id=$2 AND s.runtime_id=$3 AND s.code_trust='trusted'
    AND s.desired_state='running' AND s.state IN ('running','degraded')
    AND a.generation=$6 AND a.encrypted_value IS NOT NULL
    AND s.agent_configuration->>'connection_id'=a.id AND can_access_environment(s.id,a.user_id)`,
  [grant.sandboxId, grant.nodeId, grant.runtimeId, grant.connectionId, grant.userId, grant.generation]);
  if (!allowed.rowCount) return c.json({ error: "Agent connection is no longer available" }, 403);
  try {
    const credentials = await connectionCredentials(grant.connectionId, grant.userId!);
    if (credentials.accountId !== grant.accountId || credentials.generation !== grant.generation) return c.json({ error: "Reopen the agent pane after changing accounts" }, 409);
    return c.json({ access_token: credentials.accessToken });
  } catch { return c.json({ error: "Reconnect ChatGPT in Agents" }, 409); }
}
