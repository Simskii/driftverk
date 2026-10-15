import { createHash, randomBytes, randomUUID } from "node:crypto";
import pg from "pg";

const baseUrl = process.env.DRIFTVERK_SMOKE_BASE_URL ?? "http://127.0.0.1:3000";
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const suffix = randomUUID().replaceAll("-", "");
const email = `${suffix}@oauth-smoke.invalid`;
const password = `Smoke-${randomBytes(18).toString("base64url")}`;
const organizationId = `oauth_org_${suffix}`;
const localClientId = `https://oauth-smoke.invalid/${suffix}/client.json`;
const cookies = new Map();
const canonicalBaseUrl = baseUrl.replace("127.0.0.1", "localhost");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function rememberCookies(response) {
  for (const cookie of response.headers.getSetCookie()) {
    const [pair] = cookie.split(";", 1);
    const separator = pair.indexOf("=");
    cookies.set(pair.slice(0, separator), pair.slice(separator + 1));
  }
}

function cookieHeader() {
  return [...cookies].map(([name, value]) => `${name}=${value}`).join("; ");
}

async function request(path, init = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    redirect: "manual",
    ...init,
    headers: {
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...(cookies.size ? { Cookie: cookieHeader() } : {}),
      Origin: canonicalBaseUrl,
      ...init.headers,
    },
  });
  rememberCookies(response);
  return response;
}

async function json(response) {
  return response.json().catch(() => null);
}

try {
  const protectedMetadata = await json(await request("/.well-known/oauth-protected-resource/mcp"));
  assert(protectedMetadata?.resource === `${canonicalBaseUrl}/mcp`, "Protected-resource metadata has the wrong resource");
  assert(protectedMetadata?.authorization_servers?.[0] === `${canonicalBaseUrl}/api/auth`, "Protected-resource metadata has the wrong issuer");
  const serverMetadata = await json(await request("/.well-known/oauth-authorization-server/api/auth"));
  assert(serverMetadata?.client_id_metadata_document_supported === true, "Authorization server does not advertise CIMD");
  assert(serverMetadata?.code_challenge_methods_supported?.includes("S256"), "Authorization server does not require modern PKCE support");

  const unauthenticatedMcp = await request("/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json", "MCP-Protocol-Version": "2026-07-28", "Mcp-Method": "tools/list" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 0, method: "tools/list", params: { _meta: {
      "io.modelcontextprotocol/protocolVersion": "2026-07-28",
      "io.modelcontextprotocol/clientCapabilities": {},
    } } }),
  });
  assert(unauthenticatedMcp.status === 401, `Unauthenticated MCP returned ${unauthenticatedMcp.status}`);
  assert(unauthenticatedMcp.headers.get("www-authenticate")?.includes("oauth-protected-resource"), "MCP challenge omitted protected-resource discovery");

  const signUp = await request("/api/auth/sign-up/email", {
    method: "POST",
    body: JSON.stringify({ name: "OAuth smoke test", email, password }),
  });
  assert(signUp.ok, `Sign-up returned ${signUp.status}: ${await signUp.text()}`);

  const user = await pool.query('SELECT id FROM "user" WHERE email = $1', [email]);
  const userId = user.rows[0]?.id;
  assert(userId, "Sign-up did not create a user");
  await pool.query('UPDATE "user" SET "emailVerified" = true WHERE id = $1', [userId]);
  await pool.query("INSERT INTO organizations (id, name, slug) VALUES ($1, 'OAuth smoke', $2)", [organizationId, `oauth-smoke-${suffix}`]);
  await pool.query(
    "INSERT INTO memberships (id, organization_id, user_id, role, created_at) VALUES ($1, $2, $3, 'admin', now())",
    [`oauth_member_${suffix}`, organizationId, userId],
  );

  cookies.clear();
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const authorize = new URLSearchParams({
    client_id: "https://chatgpt.com/oauth/client.json",
    redirect_uri: "https://chatgpt.com/connector_platform_oauth_redirect",
    response_type: "code",
    scope: "mcp:read mcp:write offline_access",
    resource: `${canonicalBaseUrl}/mcp`,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: `smoke-${suffix}`,
  });
  const authorization = await request(`/api/auth/oauth2/authorize?${authorize}`);
  const authorizationBody = await json(authorization);
  const loginUrl = authorization.headers.get("location") || authorizationBody?.url || authorizationBody?.redirect_uri;
  assert(authorization.ok || authorization.status === 302, `Authorize returned ${authorization.status}: ${JSON.stringify(authorizationBody)}`);
  assert(loginUrl, "Authorize did not return a sign-in URL");
  const login = new URL(loginUrl, baseUrl);
  assert(login.pathname === "/sign-in" && login.searchParams.has("sig"), `Unexpected sign-in URL: ${login}`);

  const signIn = await request("/api/auth/sign-in/email", {
    method: "POST",
    body: JSON.stringify({ email, password, oauth_query: login.search.slice(1) }),
  });
  const signInBody = await json(signIn);
  assert(signIn.ok, `Sign-in returned ${signIn.status}: ${JSON.stringify(signInBody)}`);
  assert(cookies.size > 0, "Sign-in did not set a session cookie");
  const consentUrl = signInBody?.url || signInBody?.redirect_uri || signIn.headers.get("location");
  assert(consentUrl, "OAuth sign-in did not return a consent URL");
  const consent = new URL(consentUrl, baseUrl);
  assert(consent.pathname === "/oauth/consent" && consent.searchParams.has("sig"), `Unexpected consent URL: ${consent}`);

  const context = await request(`/api/oauth/consent-context${consent.search}`);
  const contextBody = await json(context);
  assert(context.ok, `Consent context returned ${context.status}: ${JSON.stringify(contextBody)}`);
  assert(contextBody?.client_name === "ChatGPT", "Consent page did not identify ChatGPT");
  assert(contextBody?.organization?.id === organizationId, "Consent page selected the wrong organization");

  const accepted = await request("/api/auth/oauth2/consent", {
    method: "POST",
    headers: { Accept: "application/json" },
    body: JSON.stringify({ accept: true, oauth_query: consent.search.slice(1) }),
  });
  const acceptedBody = await json(accepted);
  const callbackUrl = acceptedBody?.url || acceptedBody?.redirect_uri || accepted.headers.get("location");
  assert(accepted.ok || accepted.status === 302, `Consent returned ${accepted.status}: ${JSON.stringify(acceptedBody)}`);
  assert(callbackUrl, "Consent did not return a callback URL");
  const callback = new URL(callbackUrl);
  assert(callback.origin === "https://chatgpt.com" && callback.searchParams.has("code"), "Consent did not issue a code to ChatGPT");

  const consentRecord = await pool.query(
    'SELECT "referenceId", resources, scopes FROM "oauthConsent" WHERE "clientId" = $1 AND "userId" = $2',
    ["https://chatgpt.com/oauth/client.json", userId],
  );
  assert(consentRecord.rows[0]?.referenceId === organizationId, "OAuth consent was not bound to the selected organization");
  assert(consentRecord.rows[0]?.resources?.includes(`${canonicalBaseUrl}/mcp`), "OAuth consent was not bound to the MCP resource");

  await pool.query(
    `INSERT INTO "oauthClient"
     (id, "clientId", name, "redirectUris", "tokenEndpointAuthMethod", "grantTypes", "responseTypes", "requirePKCE", scopes, "createdAt", "updatedAt")
     VALUES ($1, $2, 'OAuth smoke client', $3::jsonb, 'none', '["authorization_code","refresh_token"]'::jsonb, '["code"]'::jsonb, true, '["mcp:read","mcp:write","offline_access"]'::jsonb, now(), now())`,
    [`oauth_client_${suffix}`, localClientId, JSON.stringify(["http://127.0.0.1/callback"])],
  );
  await pool.query(
    `INSERT INTO "oauthClientResource" (id, "clientId", "resourceId", "createdAt") VALUES ($1, $2, $3, now())`,
    [`oauth_client_resource_${suffix}`, localClientId, `${canonicalBaseUrl}/mcp`],
  );
  const localVerifier = randomBytes(32).toString("base64url");
  const localAuthorize = new URLSearchParams({
    client_id: localClientId,
    redirect_uri: "http://127.0.0.1/callback",
    response_type: "code",
    scope: "mcp:read mcp:write offline_access",
    resource: `${canonicalBaseUrl}/mcp`,
    code_challenge: createHash("sha256").update(localVerifier).digest("base64url"),
    code_challenge_method: "S256",
    state: `local-${suffix}`,
  });
  const localAuthorization = await request(`/api/auth/oauth2/authorize?${localAuthorize}`);
  const localAuthorizationBody = await json(localAuthorization);
  const localConsentUrl = localAuthorization.headers.get("location") || localAuthorizationBody?.url || localAuthorizationBody?.redirect_uri;
  assert(localConsentUrl, `Local authorize returned ${localAuthorization.status}: ${JSON.stringify(localAuthorizationBody)}`);
  const localConsent = new URL(localConsentUrl, baseUrl);
  const localAccepted = await request("/api/auth/oauth2/consent", {
    method: "POST",
    headers: { Accept: "application/json" },
    body: JSON.stringify({ accept: true, oauth_query: localConsent.search.slice(1) }),
  });
  const localAcceptedBody = await json(localAccepted);
  const localCallbackUrl = localAcceptedBody?.url || localAcceptedBody?.redirect_uri || localAccepted.headers.get("location");
  const localCode = localCallbackUrl ? new URL(localCallbackUrl).searchParams.get("code") : null;
  assert(localCode, `Local consent did not issue an authorization code: ${JSON.stringify(localAcceptedBody)}`);
  const tokenResponse = await request("/api/auth/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: localClientId,
      code: localCode,
      redirect_uri: "http://127.0.0.1/callback",
      code_verifier: localVerifier,
      resource: `${canonicalBaseUrl}/mcp`,
    }).toString(),
  });
  const tokenBody = await json(tokenResponse);
  assert(tokenResponse.ok && tokenBody?.access_token, `Token exchange returned ${tokenResponse.status}: ${JSON.stringify(tokenBody)}`);
  const oauthMcp = await request("/mcp", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${tokenBody.access_token}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": "2026-07-28",
      "Mcp-Method": "tools/list",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: {
      "io.modelcontextprotocol/protocolVersion": "2026-07-28",
      "io.modelcontextprotocol/clientCapabilities": {},
    } } }),
  });
  const oauthMcpBody = await oauthMcp.text();
  assert(oauthMcp.status === 200, `OAuth-authenticated MCP returned ${oauthMcp.status}: ${oauthMcpBody}`);
  assert(oauthMcpBody.includes("create_environment"), "OAuth write scope did not expose create_environment");
  assert(!oauthMcpBody.includes("delete_environment"), "OAuth exposed delete_environment without the delete scope");

  await pool.query("DELETE FROM memberships WHERE organization_id = $1 AND user_id = $2", [organizationId, userId]);
  const removedMembershipMcp = await request("/mcp", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${tokenBody.access_token}`,
      "Content-Type": "application/json",
      "MCP-Protocol-Version": "2026-07-28",
      "Mcp-Method": "tools/list",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: { _meta: {
      "io.modelcontextprotocol/protocolVersion": "2026-07-28",
      "io.modelcontextprotocol/clientCapabilities": {},
    } } }),
  });
  assert(removedMembershipMcp.status === 401, "OAuth access survived removal from the bound organization");

  console.log("ChatGPT MCP OAuth authorization and bearer verification smoke test passed");
} finally {
  await pool.query('DELETE FROM "oauthClient" WHERE "clientId" = $1', [localClientId]).catch(() => undefined);
  await pool.query("DELETE FROM organizations WHERE id = $1", [organizationId]).catch(() => undefined);
  await pool.query('DELETE FROM "user" WHERE email = $1', [email]).catch(() => undefined);
  await pool.end();
}
