import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Context } from "hono";
import { db } from "./db.js";
import type { AppEnv, AuthSession } from "./types.js";
import { workspaceFor } from "./workspace.js";

export const apiScopes = ["read", "write", "delete"] as const;
export type ApiScope = (typeof apiScopes)[number];

export type ApiPrincipal = {
  credentialId: string;
  keyId: string | null;
  keyName: string;
  organizationId: string;
  organizationName: string;
  organizationSlug: string;
  actorUserId: string;
  scopes: ApiScope[];
  automationIdPrefix: string | null;
};

type ApiKeyRow = {
  id: string;
  name: string;
  organization_id: string;
  organization_name: string;
  organization_slug: string;
  created_by_user_id: string;
  secret_hash: string;
  scopes: ApiScope[];
  automation_id_prefix: string | null;
};

function hashSecret(secret: string): Buffer {
  return createHash("sha256").update(secret).digest();
}

function tokenParts(value: string): { keyId: string; secret: string } | null {
  const match = value.match(/^dvk_live_(key_[0-9a-f]{32})\.([A-Za-z0-9_-]{43})$/);
  return match ? { keyId: match[1]!, secret: match[2]! } : null;
}

export async function authenticateApiKey(request: Request): Promise<ApiPrincipal | null> {
  const authorization = request.headers.get("authorization") ?? "";
  if (!authorization.startsWith("Bearer ")) return null;
  const parts = tokenParts(authorization.slice(7).trim());
  if (!parts) return null;
  const result = await db.query<ApiKeyRow>(
    `SELECT api_keys.id, api_keys.name, api_keys.organization_id,
            organizations.name AS organization_name, organizations.slug AS organization_slug,
            api_keys.created_by_user_id, api_keys.secret_hash, api_keys.scopes,
            api_keys.automation_id_prefix
     FROM api_keys
     JOIN organizations ON organizations.id = api_keys.organization_id
     WHERE api_keys.id = $1
       AND EXISTS (SELECT 1 FROM memberships m WHERE m.organization_id=api_keys.organization_id AND m.user_id=api_keys.created_by_user_id AND m.role IN ('admin','owner'))
       AND api_keys.revoked_at IS NULL
       AND (api_keys.expires_at IS NULL OR api_keys.expires_at > now())`,
    [parts.keyId],
  );
  const row = result.rows[0];
  if (!row) return null;
  const expected = Buffer.from(row.secret_hash, "hex");
  const supplied = hashSecret(parts.secret);
  if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) return null;
  await db.query("UPDATE api_keys SET last_used_at = now() WHERE id = $1", [row.id]);
  return {
    credentialId: row.id,
    keyId: row.id,
    keyName: row.name,
    organizationId: row.organization_id,
    organizationName: row.organization_name,
    organizationSlug: row.organization_slug,
    actorUserId: row.created_by_user_id,
    scopes: row.scopes,
    automationIdPrefix: row.automation_id_prefix,
  };
}

function requestedScopes(input: unknown): ApiScope[] | null {
  if (!Array.isArray(input) || input.length === 0) return null;
  const scopes = [...new Set(input.map(String))];
  return scopes.every((scope): scope is ApiScope => apiScopes.includes(scope as ApiScope))
    ? scopes
    : null;
}

export async function listApiKeys(c: Context<AppEnv>, session: AuthSession) {
  const workspace = await workspaceFor(session.user, session.session.activeOrganizationId);
  if (workspace.role !== "admin") return c.json({ api_keys: [], can_manage: false });
  const result = await db.query(
    `SELECT id, name, secret_prefix, scopes, automation_id_prefix, created_at, last_used_at, expires_at, revoked_at
     FROM api_keys WHERE organization_id = $1 ORDER BY created_at DESC`,
    [workspace.organization_id],
  );
  return c.json({ api_keys: result.rows, can_manage: true });
}

export async function createApiKey(c: Context<AppEnv>, session: AuthSession) {
  const workspace = await workspaceFor(session.user, session.session.activeOrganizationId);
  if (workspace.role !== "admin") return c.json({ error: "Admin access required" }, 403);
  const input = await c.req.json<Record<string, unknown>>().catch(() => null);
  const name = String(input?.name ?? "").trim().slice(0, 80);
  const scopes = requestedScopes(input?.scopes);
  const automationIdPrefix = String(input?.automation_id_prefix ?? "").trim() || null;
  if (!name) return c.json({ error: "API key name is required" }, 400);
  if (!scopes?.includes("read")) return c.json({ error: "API keys must include the read scope" }, 400);
  if (automationIdPrefix && !/^github:[0-9]+:pr:$/.test(automationIdPrefix))
    return c.json({ error: "Automation scope must use github:<repository-id>:pr:" }, 400);
  const id = `key_${crypto.randomUUID().replaceAll("-", "")}`;
  const secret = randomBytes(32).toString("base64url");
  const token = `dvk_live_${id}.${secret}`;
  const prefix = `${token.slice(0, 24)}...`;
  await db.query(
    `INSERT INTO api_keys
       (id, organization_id, name, secret_hash, secret_prefix, scopes, created_by_user_id, automation_id_prefix)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [id, workspace.organization_id, name, hashSecret(secret).toString("hex"), prefix, scopes, session.user.id, automationIdPrefix],
  );
  return c.json({
    api_key: { id, name, prefix, scopes, automation_id_prefix: automationIdPrefix, token },
    warning: "Copy this token now. Driftverk will not show it again.",
  }, 201);
}

export async function revokeApiKey(c: Context<AppEnv>, session: AuthSession) {
  const workspace = await workspaceFor(session.user, session.session.activeOrganizationId);
  if (workspace.role !== "admin") return c.json({ error: "Admin access required" }, 403);
  const result = await db.query(
    `UPDATE api_keys SET revoked_at = COALESCE(revoked_at, now())
     WHERE id = $1 AND organization_id = $2 RETURNING id`,
    [c.req.param("id"), workspace.organization_id],
  );
  if (!result.rowCount) return c.json({ error: "API key not found" }, 404);
  return c.body(null, 204);
}
