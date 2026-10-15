import { parseDevelopmentConfig } from "./development-config.js";
import { suggestProjectSetup } from "./project-detection.js";
import { createHash, randomBytes } from "node:crypto";
import type { Context } from "hono";
import { config } from "./config.js";
import { db } from "./db.js";
import { decryptSecret, encryptSecret, secretContext } from "./secrets.js";
import { workspaceFor } from "./workspace.js";
import type { AppEnv } from "./types.js";

export async function githubToken(userId: string, organizationId: string): Promise<string | null> {
  const result = await db.query<{ encrypted_token: string; iv: string; refresh_token_encrypted: string | null; refresh_token_iv: string | null; token_expires_at: Date | null; connection_type: string }>("SELECT encrypted_token, iv, refresh_token_encrypted, refresh_token_iv, token_expires_at, connection_type FROM user_github_connections WHERE user_id = $1 AND EXISTS (SELECT 1 FROM memberships WHERE user_id = $1 AND organization_id = $2)", [userId, organizationId]);
  const row = result.rows[0];
  if (!row) return null;
  if (row.connection_type !== "github_app" || !row.refresh_token_encrypted || !row.refresh_token_iv || !row.token_expires_at || row.token_expires_at.getTime() > Date.now() + 5 * 60_000)
    return decryptSecret(row.encrypted_token, row.iv, secretContext.userGithub(userId));
  if (!config.githubAppClientId || !config.githubAppClientSecret) throw new Error("GitHub App is not configured");
  const refreshToken = decryptSecret(row.refresh_token_encrypted, row.refresh_token_iv, `${secretContext.userGithub(userId)}:refresh`);
  const refreshed = await exchangeGitHubToken({ grant_type: "refresh_token", refresh_token: refreshToken });
  await saveGitHubConnection(userId, refreshed);
  return refreshed.access_token;
}

type GitHubTokenResponse = { access_token: string; expires_in?: number; refresh_token?: string; refresh_token_expires_in?: number; error?: string; error_description?: string };

async function exchangeGitHubToken(input: Record<string, string>): Promise<GitHubTokenResponse> {
  const response = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST", headers: { Accept: "application/json", "Content-Type": "application/json", "User-Agent": "Driftverk" },
    body: JSON.stringify({ client_id: config.githubAppClientId, client_secret: config.githubAppClientSecret, ...input }),
    redirect: "error", signal: AbortSignal.timeout(15_000),
  });
  const result = await response.json() as GitHubTokenResponse;
  if (!response.ok || result.error || !result.access_token) throw new Error(result.error_description || "GitHub authorization failed");
  return result;
}

async function saveGitHubConnection(userId: string, token: GitHubTokenResponse) {
  const user = await githubRequest("/user", token.access_token);
  const access = encryptSecret(token.access_token, secretContext.userGithub(userId));
  const refresh = token.refresh_token ? encryptSecret(token.refresh_token, `${secretContext.userGithub(userId)}:refresh`) : null;
  await db.query(`INSERT INTO user_github_connections
      (user_id, login, encrypted_token, iv, refresh_token_encrypted, refresh_token_iv, token_expires_at, connection_type)
    VALUES ($1,$2,$3,$4,$5,$6,$7,'github_app')
    ON CONFLICT (user_id) DO UPDATE SET login=EXCLUDED.login, encrypted_token=EXCLUDED.encrypted_token,
      iv=EXCLUDED.iv, refresh_token_encrypted=EXCLUDED.refresh_token_encrypted, refresh_token_iv=EXCLUDED.refresh_token_iv,
      token_expires_at=EXCLUDED.token_expires_at, connection_type='github_app', updated_at=now()`,
    [userId, user.login, access.encryptedValue, access.iv, refresh?.encryptedValue || null, refresh?.iv || null,
      token.expires_in ? new Date(Date.now() + token.expires_in * 1000) : null]);
  return { login: String(user.login) };
}

function safeReturnPath(value: string | undefined) {
  return value?.startsWith("/") && !value.startsWith("//") && value.length <= 300 ? value : "/environments/new";
}

export async function githubConnect(c: Context<AppEnv>) {
  const workspace = await workspaceFor(c.get("authSession").user, c.get("authSession").session.activeOrganizationId);
  if (!config.githubAppClientId || !config.githubAppSlug) return c.json({ error: "GitHub App is not configured" }, 503);
  const state = randomBytes(32).toString("base64url");
  await db.query("DELETE FROM user_github_oauth_states WHERE expires_at < now()");
  await db.query(`INSERT INTO user_github_oauth_states (state_hash, organization_id, user_id, return_path, expires_at)
    VALUES ($1,$2,$3,$4,now()+interval '10 minutes')`, [createHash("sha256").update(state).digest("hex"), workspace.organization_id,
    c.get("authSession").user.id, safeReturnPath(c.req.query("return"))]);
  return c.redirect(`https://github.com/apps/${encodeURIComponent(config.githubAppSlug)}/installations/new?state=${encodeURIComponent(state)}`);
}

export async function githubCallback(c: Context<AppEnv>) {
  const session = c.get("authSession");
  const state = c.req.query("state") || "", code = c.req.query("code") || "";
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query<{ organization_id: string; return_path: string }>(`DELETE FROM user_github_oauth_states
      WHERE state_hash=$1 AND user_id=$2 AND expires_at>now() RETURNING organization_id,return_path`,
      [createHash("sha256").update(state).digest("hex"), session.user.id]);
    if (!result.rows[0] || !code) { await client.query("ROLLBACK"); return c.redirect("/environments/new?github=failed"); }
    const membership = await client.query("SELECT 1 FROM memberships WHERE organization_id=$1 AND user_id=$2", [result.rows[0].organization_id, session.user.id]);
    if (!membership.rowCount) { await client.query("ROLLBACK"); return c.redirect("/environments/new?github=failed"); }
    await client.query("COMMIT");
    const token = await exchangeGitHubToken({ code, redirect_uri: new URL("/api/github/callback", config.betterAuthUrl).toString() });
    await saveGitHubConnection(session.user.id, token);
    const destination = new URL(result.rows[0].return_path, config.betterAuthUrl);
    destination.searchParams.set("github", "connected");
    return c.redirect(`${destination.pathname}${destination.search}`);
  } catch { await client.query("ROLLBACK").catch(() => undefined); return c.redirect("/environments/new?github=failed"); }
  finally { client.release(); }
}

export async function githubRequest(path: string, token: string | null) {
  const response = await fetch(`https://api.github.com${path}`, {
    headers: { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "Driftverk", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    redirect: "error", signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(response.status === 401 ? "GitHub token is invalid or expired" : response.status === 404 ? "Repository or branch not found, or the GitHub connection cannot access it" : `GitHub request failed (${response.status}). Check repository access and rate limits.`);
  return response.json();
}

export async function githubConnection(c: Context<AppEnv>) {
  await workspaceFor(c.get("authSession").user, c.get("authSession").session.activeOrganizationId);
  if (c.req.method === "GET") {
    const result = await db.query("SELECT login, connection_type, updated_at FROM user_github_connections WHERE user_id = $1", [c.get("authSession").user.id]);
    return c.json({ connection: result.rows[0] ?? null, oauth_available: Boolean(config.githubAppClientId && config.githubAppSlug) });
  }
  if (c.req.method === "DELETE") {
    await db.query("DELETE FROM user_github_connections WHERE user_id = $1", [c.get("authSession").user.id]);
    return c.json({ deleted: true });
  }
  const input = await c.req.json().catch(() => null);
  const token = String(input?.token ?? "").trim();
  if (!token || token.length > 4096 || /\s/.test(token)) return c.json({ error: "Enter a GitHub token" }, 400);
  try {
    const user = await githubRequest("/user", token);
    const encrypted = encryptSecret(token, secretContext.userGithub(c.get("authSession").user.id));
    await db.query(`INSERT INTO user_github_connections (user_id, login, encrypted_token, iv)
      VALUES ($1, $2, $3, $4) ON CONFLICT (user_id) DO UPDATE SET login = EXCLUDED.login,
      encrypted_token = EXCLUDED.encrypted_token, iv = EXCLUDED.iv, refresh_token_encrypted = NULL, refresh_token_iv = NULL, token_expires_at = NULL, connection_type = 'legacy_token', updated_at = now()`, [c.get("authSession").user.id, user.login, encrypted.encryptedValue, encrypted.iv]);
    return c.json({ connection: { login: user.login } });
  } catch (error) { return c.json({ error: error instanceof Error ? error.message : "Could not connect GitHub" }, 400); }
}

export async function githubRepositories(c: Context<AppEnv>) {
  const workspace = await workspaceFor(c.get("authSession").user, c.get("authSession").session.activeOrganizationId);
  const token = await githubToken(c.get("authSession").user.id, workspace.organization_id);
  if (!token) return c.json({ repositories: [], next_page: null });
  const page = Number(c.req.query("page") || 1);
  if (!Number.isInteger(page) || page < 1 || page > 1000) return c.json({ error: "Invalid page" }, 400);
  try {
    const rows = await githubRequest(`/user/repos?per_page=100&sort=updated&page=${page}`, token);
    return c.json({ repositories: rows.filter((row: { disabled: boolean }) => !row.disabled).map((row: { full_name: string; default_branch: string; private: boolean }) => ({ full_name: row.full_name, default_branch: row.default_branch, private: row.private })), next_page: rows.length === 100 ? page + 1 : null });
  } catch (error) { return c.json({ error: error instanceof Error ? error.message : "Could not load repositories" }, 400); }
}

export async function githubProjectSetup(c: Context<AppEnv>) {
  const workspace = await workspaceFor(c.get("authSession").user, c.get("authSession").session.activeOrganizationId);
  try {
    const { repository, repository_branch } = parseDevelopmentConfig({ repository: c.req.query("repository"), repository_branch: c.req.query("branch") });
    if (!repository) return c.json({ error: "Choose a repository first" }, 400);
    const token = await githubToken(c.get("authSession").user.id, workspace.organization_id);
    const ref = repository_branch ? `?ref=${encodeURIComponent(repository_branch)}` : "";
    const entries = await githubRequest(`/repos/${repository}/contents/${ref}`, token);
    if (!Array.isArray(entries)) throw new Error("Could not inspect the repository root");
    const files = entries.filter(entry => entry.type === "file").map(entry => String(entry.name));
    let manifest: unknown = null;
    if (files.includes("package.json")) {
      const entry = entries.find(entry => entry.name === "package.json");
      if (entry.size > 131072) throw new Error("package.json is too large to inspect. Enter commands manually.");
      const file = await githubRequest(`/repos/${repository}/contents/package.json${ref}`, token);
      if (file.encoding !== "base64" || typeof file.content !== "string" || file.content.length > 180000) throw new Error("Could not read package.json. Enter commands manually.");
      manifest = JSON.parse(Buffer.from(file.content, "base64").toString("utf8"));
    }
    return c.json(suggestProjectSetup(files, manifest));
  } catch (error) { return c.json({ error: error instanceof Error ? error.message : "Could not detect project setup" }, 400); }
}
