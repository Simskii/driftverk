import type { Context } from "hono";
import type { PoolClient } from "pg";
import { db } from "./db.js";
import { workspaceFor } from "./workspace.js";
import { encryptSecret, decryptSecret, secretContext } from "./secrets.js";
import { agentDefinitions, parseAgentId, parseAgentModel, parseAgentAuthMethod, type AgentConfiguration } from "./agent-config.js";
import type { AppEnv } from "./types.js";

// Only explicit selections receive credentials. API callers never inherit an org default.
export async function resolveAgentSetup(organizationId: string, selection: unknown, trusted: boolean, names: string[], client: Pick<PoolClient, "query"> = db, authMethod?: unknown, userId?: string) {
  const method = parseAgentAuthMethod(authMethod);
  const id = parseAgentId(selection);
  if (!id) return { configuration: null as AgentConfiguration | null, secretNames: names };
  if (!trusted) throw new Error("Agents require a trusted environment and an unrestricted organization actor");
  if (method === "subscription") {
    if (names.includes(agentDefinitions[id].secretName)) throw new Error("Remove the provider API key from organization secrets to use a subscription");
    if (id === "codex") {
      if (!userId) throw new Error("Sign in to Driftverk and connect ChatGPT in Agents first");
      const connection = (await client.query<{ id: string; model: string | null }>(
        "SELECT id,model FROM user_agent_connections WHERE user_id=$1 AND agent_id='codex' AND encrypted_value IS NOT NULL FOR SHARE", [userId])).rows[0];
      if (!connection) throw new Error("Connect ChatGPT in Agents first");
      return { configuration: { id, model: connection.model, auth_method: method, connection_id: connection.id } as AgentConfiguration, secretNames: names };
    }
    return { configuration: { id, model: null, auth_method: method } as AgentConfiguration, secretNames: names };
  }
  const result = await client.query<{ model: string | null }>(
    `SELECT a.model FROM organization_secrets s LEFT JOIN organization_agents a ON a.organization_id = s.organization_id AND a.agent_id = $3
     WHERE s.organization_id = $1 AND s.name = $2 FOR SHARE OF s`, [organizationId, agentDefinitions[id].secretName, id]);
  if (!result.rowCount) throw new Error(`Connect ${agentDefinitions[id].name} in Agents first`);
  return { configuration: { id, model: parseAgentModel(result.rows[0]!.model) }, secretNames: [...new Set([...names, agentDefinitions[id].secretName])] };
}

export async function agents(c: Context<AppEnv>) {
  const session = c.get("authSession");
  const workspace = await workspaceFor(session.user, session.session.activeOrganizationId);
  if (c.req.method === "GET") {
    const [profiles, secrets, personal] = await Promise.all([
      db.query<{ agent_id: string; model: string | null; is_default: boolean }>("SELECT agent_id, model, is_default FROM organization_agents WHERE organization_id = $1", [workspace.organization_id]),
      db.query<{ name: string }>("SELECT name FROM organization_secrets WHERE organization_id = $1 AND name = ANY($2::text[])", [workspace.organization_id, Object.values(agentDefinitions).map(agent => agent.secretName)]),
      db.query<{ id: string; model: string | null; is_default: boolean }>("SELECT id,model,is_default FROM user_agent_connections WHERE user_id=$1 AND agent_id='codex' AND encrypted_value IS NOT NULL", [session.user.id]),
    ]);
    return c.json({ can_manage: workspace.role === "admin", agents: Object.entries(agentDefinitions).map(([id, definition]) => {
      const profile = profiles.rows.find(profile => profile.agent_id === id);
      const connected = secrets.rows.some(secret => secret.name === definition.secretName);
      const subscription = id === "codex" ? personal.rows[0] : undefined;
      const personalDefault = Boolean(personal.rows[0]?.is_default);
      return { id, name: definition.name, model: profile?.model ?? null, connected, api_key_is_default: connected && Boolean(profile?.is_default),
        subscription_connected: Boolean(subscription), subscription_model: subscription?.model ?? null,
        default_auth_method: personalDefault && id === "codex" ? "subscription" : "api_key",
        is_default: personalDefault ? id === "codex" : connected && Boolean(profile?.is_default) };
    }) });
  }
  if (workspace.role !== "admin") return c.json({ error: "Admin access required" }, 403);
  let id;
  try { id = parseAgentId(c.req.param("id")); } catch { return c.json({ error: "Unknown agent" }, 400); }
  if (!id) return c.json({ error: "Unknown agent" }, 400);
  const secretName = agentDefinitions[id].secretName;
  if (c.req.method === "POST") {
    const result = await db.query<{ encrypted_value: string; iv: string }>("SELECT encrypted_value, iv FROM organization_secrets WHERE organization_id = $1 AND name = $2", [workspace.organization_id, secretName]);
    if (!result.rowCount) return c.json({ error: "Save an API key first" }, 400);
    const key = decryptSecret(result.rows[0]!.encrypted_value, result.rows[0]!.iv, secretContext.organization(workspace.organization_id, secretName));
    try {
      const response = await fetch(id === "codex" ? "https://api.openai.com/v1/models" : "https://api.anthropic.com/v1/models", {
        headers: id === "codex" ? { Authorization: `Bearer ${key}` } : { "x-api-key": key, "anthropic-version": "2023-06-01" },
        signal: AbortSignal.timeout(10_000), redirect: "error",
      });
      await response.body?.cancel();
      if (!response.ok) return c.json({ error: response.status === 401 || response.status === 403 ? "The provider rejected this key or its permissions. Check the key and try again." : "The provider could not verify this key. Try again later." }, 400);
      return c.json({ message: "API key accepted. Model access and available credit are checked when you run the agent." });
    } catch { return c.json({ error: "Could not reach the provider. Try again later." }, 502); }
  }
  const input = c.req.method === "DELETE" ? {} : await c.req.json().catch(() => null);
  if (!input || typeof input !== "object" || Array.isArray(input)) return c.json({ error: "Invalid agent configuration" }, 400);
  let model;
  try { model = parseAgentModel(input.model); } catch (error) { return c.json({ error: (error as Error).message }, 400); }
  if (input.api_key !== undefined && (typeof input.api_key !== "string" || !/^[\x21-\x7e]{1,4096}$/.test(input.api_key))) return c.json({ error: "Enter a valid API key without spaces" }, 400);
  if (input.is_default !== undefined && typeof input.is_default !== "boolean") return c.json({ error: "Invalid default selection" }, 400);
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    // Serialize default changes, including the first profile created for an organization.
    await client.query("SELECT id FROM organizations WHERE id = $1 FOR UPDATE", [workspace.organization_id]);
    if (c.req.method === "DELETE") {
      await client.query("DELETE FROM organization_agents WHERE organization_id = $1 AND agent_id = $2", [workspace.organization_id, id]);
      await client.query("DELETE FROM organization_secrets WHERE organization_id = $1 AND name = $2", [workspace.organization_id, secretName]);
    } else {
      if (input.api_key) {
        const encrypted = encryptSecret(input.api_key, secretContext.organization(workspace.organization_id, secretName));
        await client.query(`INSERT INTO organization_secrets (organization_id, name, encrypted_value, iv) VALUES ($1,$2,$3,$4)
          ON CONFLICT (organization_id, name) DO UPDATE SET encrypted_value = EXCLUDED.encrypted_value, iv = EXCLUDED.iv, updated_at = now()`, [workspace.organization_id, secretName, encrypted.encryptedValue, encrypted.iv]);
      }
      const exists = await client.query("SELECT 1 FROM organization_secrets WHERE organization_id = $1 AND name = $2 FOR SHARE", [workspace.organization_id, secretName]);
      if (!exists.rowCount) { await client.query("ROLLBACK"); return c.json({ error: "Add an API key to connect this agent" }, 400); }
      if (input.is_default === true) await client.query("UPDATE organization_agents SET is_default = false WHERE organization_id = $1", [workspace.organization_id]);
      await client.query(`INSERT INTO organization_agents (organization_id, agent_id, model, is_default) VALUES ($1,$2,$3,$4)
        ON CONFLICT (organization_id, agent_id) DO UPDATE SET model = EXCLUDED.model, is_default = EXCLUDED.is_default`, [workspace.organization_id, id, model, input.is_default === true]);
    }
    await client.query("COMMIT");
    return c.json({ saved: true });
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
}
