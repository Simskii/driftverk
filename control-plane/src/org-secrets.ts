import type { Context } from "hono";
import type { PoolClient } from "pg";
import { db } from "./db.js";
import { workspaceFor } from "./workspace.js";
import { parseOrganizationSecretNames } from "./development-config.js";
import { encryptSecret, decryptSecret, secretContext } from "./secrets.js";
import type { AppEnv } from "./types.js";

// Copy explicitly selected secrets at creation. Rotation never mutates existing environments.
// Reject collisions instead of silently overriding a direct environment variable.
export async function resolveOrganizationSecrets(organizationId: string, names: string[], variables: Array<{ name: string; value: string }>, client: Pick<PoolClient, "query"> = db) {
  if (names.some(name => variables.some(variable => variable.name === name))) throw new Error("An organization secret conflicts with an environment variable; choose one source");
  if (names.length + variables.length > 25) throw new Error("Use at most 25 environment variables including organization secrets");
  if (!names.length) return [];
  const result = await client.query<{ name: string; encrypted_value: string; iv: string }>(
    "SELECT name, encrypted_value, iv FROM organization_secrets WHERE organization_id = $1 AND name = ANY($2::text[]) FOR SHARE", [organizationId, names]);
  const rows = new Map(result.rows.map(row => [row.name, row]));
  const missing = names.filter(name => !rows.has(name));
  if (missing.length) throw new Error(`Required organization secrets are missing: ${missing.join(", ")}`);
  return names.map(name => {
    const row = rows.get(name)!;
    return { name, value: decryptSecret(row.encrypted_value, row.iv, secretContext.organization(organizationId, name)) };
  });
}

export async function validateOrganizationSecretReferences(organizationId: string, names: string[]) {
  if (!names.length) return;
  const result = await db.query<{ name: string }>("SELECT name FROM organization_secrets WHERE organization_id = $1 AND name = ANY($2::text[])", [organizationId, names]);
  const missing = names.filter(name => !result.rows.some(row => row.name === name));
  if (missing.length) throw new Error(`Required organization secrets are missing: ${missing.join(", ")}`);
}

export async function organizationSecrets(c: Context<AppEnv>) {
  const session = c.get("authSession");
  const workspace = await workspaceFor(session.user, session.session.activeOrganizationId);
  if (c.req.method === "GET") {
    const result = await db.query("SELECT name, updated_at FROM organization_secrets WHERE organization_id = $1 ORDER BY name", [workspace.organization_id]);
    return c.json({ secrets: result.rows, can_manage: workspace.role === "admin" });
  }
  if (workspace.role !== "admin") return c.json({ error: "Admin access required" }, 403);
  if (c.req.method === "DELETE") {
    const name = c.req.param("name");
    try { parseOrganizationSecretNames([name]); } catch { return c.json({ error: "Invalid organization secret name" }, 400); }
    const result = await db.query("DELETE FROM organization_secrets WHERE organization_id = $1 AND name = $2", [workspace.organization_id, name]);
    return result.rowCount ? c.json({ deleted: true }) : c.json({ error: "Organization secret not found" }, 404);
  }
  const input = await c.req.json().catch(() => null);
  try { parseOrganizationSecretNames([input?.name]); } catch { return c.json({ error: "Invalid organization secret name" }, 400); }
  if (typeof input?.value !== "string" || !input.value.length || input.value.length > 32768 || input.value.includes("\0")) return c.json({ error: "Use a secret value of 1–32768 characters without null bytes" }, 400);
  const encrypted = encryptSecret(input.value, secretContext.organization(workspace.organization_id, input.name));
  const result = await db.query(
    `INSERT INTO organization_secrets (organization_id, name, encrypted_value, iv) VALUES ($1, $2, $3, $4)
     ON CONFLICT (organization_id, name) DO UPDATE SET encrypted_value = EXCLUDED.encrypted_value, iv = EXCLUDED.iv, updated_at = now()
     RETURNING name, updated_at`, [workspace.organization_id, input.name, encrypted.encryptedValue, encrypted.iv]);
  return c.json({ secret: result.rows[0] });
}
