import { renderAgentInstaller } from "./agent-installer.js";
import { environmentTasks } from './environment-tasks.js';
import { cliDownload } from "./cli-downloads.js";
import { memberCreationSettings } from "./member-self-service.js";
import { agentConnection, agentCredential } from "./agent-connections.js";
import { agents } from "./agents.js";
import { TERMS_VERSION, LEGAL_ORIGIN } from "./legal.js";
import { requireEnvironmentAccess, environmentMembers, memberEnvironments, setEnvironmentMember } from "./environment-access.js";
import { organizationSecrets } from "./org-secrets.js";
import { environmentDesktop } from "./desktop.js";
import { environmentTailscale } from "./tailscale.js";
import { listSystemSnapshots } from "./system-snapshots.js";
import { exampleApp } from "./example-app.js";
import { billingSummary, billingHosts, billingCheckout, billingPortal, stripeWebhook, isBillingError } from "./billing.js";
import { prebuildsPanel } from "./prebuilds.js";
import { githubCallback, githubConnect, githubConnection, githubRepositories, githubProjectSetup } from "./github.js";
import { listHosts, updateHosting, removeHost } from "./hosts.js";
import { environmentTemplates } from "./environment-templates.js";
import { preparedPreviewSettings } from "./prepared-previews.js";
import { readFile } from "node:fs/promises";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono, type Context, type Next } from "hono";
import { HTTPException } from "hono/http-exception";
import { bodyLimit } from "hono/body-limit";
import { auth } from "./auth.js";
import { createApiKey, listApiKeys, revokeApiKey } from "./api-keys.js";
import { adminAccess, setAdminComplimentaryAccess, grantAdminCredit, isPlatformAdmin, listAdminOrganizations, revokeAdminComputeAgent, updateAdminOrganization } from "./admin.js";
import { registerComputeRoutes } from "./compute.js";
import { createRegistry, createSnapshot, deleteRegistry, deleteSnapshot, listRegistries, listSnapshots } from "./catalog.js";
import { config } from "./config.js";
import { db } from "./db.js";
import { faviconSvg } from "./html.js";
import { createPreview } from "./preview.js";
import { createSshKey, deleteSshKey, listSshKeys } from "./ssh-keys.js";
import { listTeam } from "./team.js";
import { handleMcp } from "./mcp.js";
import { getOAuthConsentContext } from "./oauth-ui.js";
import { registerPublicApiRoutes } from "./public-api.js";
import { createTerminalTicket } from "./terminal.js";
import { approveComputeAgentSetup, getComputeAgentSetup, pollComputeAgentSetup, startComputeAgentSetup } from "./compute-agent-setup.js";
import { createWebhook, deleteWebhook, listWebhooks, retryWebhook, testWebhook, updateWebhook } from "./webhooks.js";
import { createVolume, listVolumes } from "./volumes.js";
import type { AppEnv, AuthSession } from "./types.js";
import {
  createEnvironment,
  environmentAction,
  updateEnvironmentLifecycle,
  updateEnvironmentResources,
  getEnvironmentTelemetry,
  getEnvironment,
  listEnvironments,
  upsertEnvironmentVariable,
  deleteEnvironmentVariable,
  updateEnvironmentPreview,
  updateEnvironmentSsh,
} from "./workspace.js";

export const app = new Hono<AppEnv>();

app.use("*", async (c, next) => {
  const nonce = crypto.randomUUID().replaceAll("-", "");
  const requestId = c.req.header("x-request-id")?.slice(0, 128) || `req_${crypto.randomUUID()}`;
  c.set("nonce", nonce);
  c.set("requestId", requestId);
  await next();
  c.header(
    "Content-Security-Policy",
    `default-src 'none'; style-src 'self' 'nonce-${nonce}'; script-src 'self' 'nonce-${nonce}'; connect-src 'self'; img-src 'self' data:; frame-src https://*.${config.previewDomain}; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`,
  );
  c.header("Referrer-Policy", "strict-origin-when-cross-origin");
  c.header("X-Content-Type-Options", "nosniff");
  c.header("X-Frame-Options", "DENY");
  c.header("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  c.header("X-Request-Id", requestId);
  if (config.nodeEnv === "production")
    c.header("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
});

app.get("/health", async (c) => {
  await db.query("SELECT 1");
  return c.json({ status: "ok" });
});

app.get("/favicon.svg", () =>
  new Response(faviconSvg, {
    headers: {
      "Cache-Control": "public, max-age=86400",
      "Content-Type": "image/svg+xml; charset=utf-8",
    },
  }),
);

app.get("/favicon.ico", () =>
  new Response(null, {
    status: 204,
    headers: { "Cache-Control": "public, max-age=86400" },
  }),
);

import { computeAgentVersion } from './compute-agent-version.js';
const installerRoot = new URL("../installer/", import.meta.url);
app.get('/install/version', c => c.text(computeAgentVersion, 200, { 'Cache-Control': 'no-store' }));
const computeAgentBundleRoot = new URL("../compute-agent-bundle/", import.meta.url);
const computeAgentBundleFiles = new Set([
  "compose.compute.yaml",
  "infrastructure/compute-agent/Dockerfile",
  "infrastructure/compute-agent/LICENSE",
  "infrastructure/compute-agent/package.json",
  "infrastructure/compute-agent/package-lock.json",
  "infrastructure/compute-agent/index.mjs",
  "infrastructure/compute-agent/health.mjs",
  "infrastructure/compute-agent/agent-terminal.mjs",
  "infrastructure/compute-agent/agent-sessions.mjs",
  "infrastructure/compute-agent/agent-connection.mjs",
  "infrastructure/compute-agent/persistent-terminal.mjs",
  "infrastructure/compute-agent/runtime-probe.mjs",
  "infrastructure/compute-agent/websocket-activity.mjs",
  "infrastructure/compute-agent/executions.mjs",
  "infrastructure/compute-agent/execution-worker.py",
  "infrastructure/compute-agent/resolve-access.mjs",
  "infrastructure/compute-agent/image-cleanup.mjs",
  "infrastructure/compute-agent/data-tunnel.mjs",
  "infrastructure/compute-agent/ssh-loopback.mjs",
  "infrastructure/compute-agent/tunnel-protocol.mjs",
  "infrastructure/compute-agent/docker-runtime.mjs",
  "infrastructure/compute-agent/snapshot-storage.mjs",
  "infrastructure/compute-agent/volume-storage.mjs",
  "infrastructure/compute-agent/preview-gateway.mjs",
  "infrastructure/compute-agent/preview-status-page.mjs",
  "infrastructure/compute-agent/web-terminal.mjs",
]);

app.get("/install/watchdog", async (c) => c.body(await readFile(new URL("watchdog.sh", installerRoot), "utf8"), 200, { "Content-Type": "text/x-shellscript; charset=utf-8" }));
app.get("/install/agent", async (c) => c.body(renderAgentInstaller(await readFile(new URL("agent.sh", installerRoot), "utf8"), config.betterAuthUrl), 200, {
  "Content-Type": "text/x-shellscript; charset=utf-8",
  "Cache-Control": "no-store",
}));
app.get("/install/agent-cli", async (c) => c.body(await readFile(new URL("driftverk-agent", installerRoot), "utf8"), 200, {
  "Content-Type": "text/x-shellscript; charset=utf-8",
  "Cache-Control": "no-store",
}));
app.get("/install/cli", async (c) => c.body(await readFile(new URL("cli.sh", installerRoot), "utf8"), 200, {
  "Content-Type": "text/x-shellscript; charset=utf-8",
  "Cache-Control": "no-store",
}));
app.get("/install/cli.ps1", async (c) => c.body(await readFile(new URL("cli.ps1", installerRoot), "utf8"), 200, {
  "Content-Type": "text/plain; charset=utf-8",
  "Cache-Control": "no-store",
}));
app.get("/install/bin/:file", cliDownload(installerRoot));
app.get("/install/bundle/*", async (c) => {
  const file = c.req.path.slice("/install/bundle/".length);
  if (!computeAgentBundleFiles.has(file)) return c.notFound();
  return c.body(await readFile(new URL(file, computeAgentBundleRoot)), 200, {
    "Content-Type": file.endsWith(".yaml") ? "application/yaml" : "application/octet-stream",
    "Cache-Control": "public, max-age=300",
  });
});

app.post("/api/stripe/webhook", bodyLimit({ maxSize: 1024 * 1024 }), stripeWebhook);
app.get("/api/cli/config", c => c.json({ terms_version: config.termsVersion, terms_url: config.termsUrl, privacy_url: config.privacyUrl, example: { ...exampleApp, preview_port: 3000 } }));
app.get("/api/config", async (c) => {
  const snapshots = await listSystemSnapshots();
  const defaultSnapshot = snapshots.find(snapshot => snapshot.is_default);
  return c.json({ installationMode: config.installationMode, requireEmailVerification: config.requireEmailVerification, termsVersion: config.termsVersion, termsUrl: config.termsUrl, privacyUrl: config.privacyUrl, allowSignUp: config.allowSignUp, defaultImage: defaultSnapshot?.base_image || config.defaultSandboxImage, defaultSnapshotId: defaultSnapshot?.id || null });
});
app.all("/api/auth/*", (c) => auth.handler(c.req.raw));
app.all("/.well-known/*", (c) => auth.handler(c.req.raw));
app.post("/api/compute-agent-setup/start", startComputeAgentSetup);
app.post("/api/compute-agent-setup/poll", pollComputeAgentSetup);
registerComputeRoutes(app);
app.use("/v1/*", bodyLimit({ maxSize: 1024 * 1024, onError: (c) => c.json({ error: { code: "request_too_large", message: "Request body exceeds 1 MiB" } }, 413) }));
app.use("/mcp", bodyLimit({ maxSize: 1024 * 1024, onError: (c) => c.json({ error: "request_too_large" }, 413) }));
registerPublicApiRoutes(app);
app.post("/mcp", handleMcp);
app.all("/mcp", (c) => c.json({ error: "method_not_allowed" }, 405, { Allow: "POST" }));

async function sessionFor(c: Context<AppEnv>): Promise<AuthSession | null> {
  return auth.api.getSession({ headers: c.req.raw.headers }) as Promise<AuthSession | null>;
}

async function requireSession(c: Context<AppEnv>, next: Next) {
  const session = await sessionFor(c);
  if (!session) return c.json({ error: "Authentication required" }, 401);
  c.set("authSession", session);
  await next();
}

async function requireTrustedOrigin(c: Context<AppEnv>, next: Next) {
  const origin = c.req.header("origin");
  if (!origin || !config.trustedOrigins.includes(origin))
    return c.json({ error: "Untrusted request origin" }, 403);
  await next();
}

async function requirePlatformAdmin(c: Context<AppEnv>, next: Next) {
  if (!isPlatformAdmin(c.get("authSession"))) return c.json({ error: "Platform administrator access required" }, 403);
  await next();
}

app.get("/api/member-environment-settings", requireSession, memberCreationSettings);
app.put("/api/member-environment-settings", requireSession, requireTrustedOrigin, memberCreationSettings);
app.get("/api/billing", requireSession, billingSummary);
app.post("/api/billing/checkout", requireSession, requireTrustedOrigin, billingCheckout);
app.post("/api/billing/hosts", requireSession, requireTrustedOrigin, billingHosts);
app.post("/api/billing/portal", requireSession, requireTrustedOrigin, billingPortal);
app.use("/api/github/*", requireSession);
app.use("/api/environment-templates", requireSession);
app.use("/api/environment-templates/*", requireSession);
app.get("/api/github/connection", githubConnection);
app.get("/api/github/connect", githubConnect);
app.get("/api/github/callback", githubCallback);
app.put("/api/github/connection", requireTrustedOrigin, githubConnection);
app.delete("/api/github/connection", requireTrustedOrigin, githubConnection);
app.get("/api/github/repositories", githubRepositories);
app.get("/api/github/project-setup", githubProjectSetup);
app.use("/api/prebuilds", requireSession);
app.get("/api/prebuilds", prebuildsPanel);
app.post("/api/prebuilds", requireTrustedOrigin, prebuildsPanel);
app.post("/api/agent-credentials/codex", agentCredential);
app.get("/api/agents/codex/connection", requireSession, agentConnection);
app.post("/api/agents/codex/connection", requireSession, requireTrustedOrigin, agentConnection);
app.put("/api/agents/codex/connection", requireSession, requireTrustedOrigin, agentConnection);
app.delete("/api/agents/codex/connection", requireSession, requireTrustedOrigin, agentConnection);
app.get("/api/agents", requireSession, agents);
app.put("/api/agents/:id", requireSession, requireTrustedOrigin, agents);
app.delete("/api/agents/:id", requireSession, requireTrustedOrigin, agents);
app.post("/api/agents/:id/test", requireSession, requireTrustedOrigin, agents);
app.get("/api/organization-secrets", requireSession, organizationSecrets);
app.post("/api/organization-secrets", requireSession, requireTrustedOrigin, organizationSecrets);
app.delete("/api/organization-secrets/:name", requireSession, requireTrustedOrigin, organizationSecrets);
app.get("/api/environment-templates", environmentTemplates);
app.post("/api/environment-templates", requireTrustedOrigin, environmentTemplates);
app.put("/api/environment-templates/:id", requireTrustedOrigin, environmentTemplates);
app.delete("/api/environment-templates/:id", requireTrustedOrigin, environmentTemplates);
app.get("/api/environment-templates/:id/prepared-preview", preparedPreviewSettings);
app.put("/api/environment-templates/:id/prepared-preview", requireTrustedOrigin, preparedPreviewSettings);
app.use("/api/environments", requireSession);
app.use("/api/hosts", requireSession);
app.use("/api/hosts/*", requireSession);
app.get("/api/hosts", listHosts);
app.put("/api/hosts/hosting", requireTrustedOrigin, updateHosting);
app.delete("/api/hosts/:id", requireTrustedOrigin, removeHost);
app.use("/api/environments/*", requireSession);
app.use("/api/environments/:id", requireEnvironmentAccess);
app.use("/api/environments/:id/*", requireEnvironmentAccess);
app.use("/api/snapshots", requireSession);
app.use("/api/snapshots/*", requireSession);
app.use("/api/volumes", requireSession);
app.use("/api/volumes/*", requireSession);
app.use("/api/registries", requireSession);
app.use("/api/registries/*", requireSession);
app.use("/api/ssh-keys", requireSession);
app.use("/api/ssh-keys/*", requireSession);
app.use("/api/team", requireSession);
app.use("/api/team/*", requireSession);
app.use("/api/oauth/consent-context", requireSession);
app.use("/api/api-keys", requireSession);
app.use("/api/api-keys/*", requireSession);
app.use("/api/webhooks", requireSession);
app.use("/api/webhooks/*", requireSession);
app.use("/api/admin/access", requireSession);
app.use("/api/admin/organizations", requireSession, requirePlatformAdmin);
app.use("/api/admin/organizations/*", requireSession, requirePlatformAdmin);
app.get("/api/environments", (c) => listEnvironments(c, c.get("authSession")));
app.get("/api/environments/:id", (c) => getEnvironment(c, c.get("authSession")));
app.get("/api/environments/:id/telemetry", (c) => getEnvironmentTelemetry(c, c.get("authSession")));
app.post("/api/environments", requireTrustedOrigin, (c) =>
  createEnvironment(c, c.get("authSession")),
);
app.post("/api/environments/:id/actions", requireTrustedOrigin, (c) =>
  environmentAction(c, c.get("authSession")),
);
app.put("/api/environments/:id/resources", requireTrustedOrigin, c => updateEnvironmentResources(c, c.get("authSession")));
app.put("/api/environments/:id/lifecycle", requireTrustedOrigin, (c) =>
  updateEnvironmentLifecycle(c, c.get("authSession")),
);
app.put("/api/environments/:id/ssh", requireTrustedOrigin, c => updateEnvironmentSsh(c, c.get("authSession")));
app.get("/api/environments/:id/tasks", c => environmentTasks(c,c.get("authSession")));
app.post("/api/environments/:id/tasks", requireTrustedOrigin, c => environmentTasks(c,c.get("authSession")));
app.get("/api/environments/:id/desktop", c => environmentDesktop(c, c.get("authSession")));
app.post("/api/environments/:id/desktop", requireTrustedOrigin, c => environmentDesktop(c, c.get("authSession")));
app.get("/api/environments/:id/tailscale", c => environmentTailscale(c, c.get("authSession")));
app.post("/api/environments/:id/tailscale", requireTrustedOrigin, c => environmentTailscale(c, c.get("authSession")));
app.put("/api/environments/:id/preview", requireTrustedOrigin, (c) =>
  updateEnvironmentPreview(c, c.get("authSession")),
);
app.post("/api/environments/:id/ports/:port/preview", requireTrustedOrigin, (c) =>
  createPreview(c, c.get("authSession")),
);
app.post("/api/environments/:id/terminal-ticket", requireTrustedOrigin, (c) =>
  createTerminalTicket(c, c.get("authSession")),
);
app.put("/api/environments/:id/environment-variables", requireTrustedOrigin, (c) =>
  upsertEnvironmentVariable(c, c.get("authSession")),
);
app.delete("/api/environments/:id/environment-variables/:name", requireTrustedOrigin, (c) =>
  deleteEnvironmentVariable(c, c.get("authSession")),
);
app.get("/api/snapshots", (c) => listSnapshots(c, c.get("authSession")));
app.post("/api/snapshots", requireTrustedOrigin, (c) => createSnapshot(c, c.get("authSession")));
app.delete("/api/snapshots/:id", requireTrustedOrigin, (c) => deleteSnapshot(c, c.get("authSession")));
app.get("/api/volumes", (c) => listVolumes(c, c.get("authSession")));
app.post("/api/volumes", requireTrustedOrigin, (c) => createVolume(c, c.get("authSession")));
app.get("/api/registries", (c) => listRegistries(c, c.get("authSession")));
app.post("/api/registries", requireTrustedOrigin, (c) =>
  createRegistry(c, c.get("authSession")),
);
app.delete("/api/registries/:id", requireTrustedOrigin, (c) =>
  deleteRegistry(c, c.get("authSession")),
);
app.get("/api/ssh-keys", (c) => listSshKeys(c, c.get("authSession")));
app.post("/api/ssh-keys", requireTrustedOrigin, (c) => createSshKey(c, c.get("authSession")));
app.delete("/api/ssh-keys/:id", requireTrustedOrigin, (c) => deleteSshKey(c, c.get("authSession")));
app.get("/api/team/:memberId/environments", memberEnvironments);
app.get("/api/environments/:id/members", environmentMembers);
app.put("/api/environments/:id/members/:memberId", requireTrustedOrigin, setEnvironmentMember);
app.get("/api/team", (c) => listTeam(c, c.get("authSession")));
app.get("/api/oauth/consent-context", (c) => getOAuthConsentContext(c, c.get("authSession")));
app.get("/api/api-keys", (c) => listApiKeys(c, c.get("authSession")));
app.post("/api/api-keys", requireTrustedOrigin, (c) => createApiKey(c, c.get("authSession")));
app.delete("/api/api-keys/:id", requireTrustedOrigin, (c) => revokeApiKey(c, c.get("authSession")));
app.get("/api/webhooks", (c) => listWebhooks(c, c.get("authSession")));
app.post("/api/webhooks", requireTrustedOrigin, (c) => createWebhook(c, c.get("authSession")));
app.patch("/api/webhooks/:id", requireTrustedOrigin, (c) => updateWebhook(c, c.get("authSession")));
app.delete("/api/webhooks/:id", requireTrustedOrigin, (c) => deleteWebhook(c, c.get("authSession")));
app.post("/api/webhooks/:id/test", requireTrustedOrigin, (c) => testWebhook(c, c.get("authSession")));
app.post("/api/webhook-deliveries/:id/retry", requireSession, requireTrustedOrigin, (c) => retryWebhook(c, c.get("authSession")));
app.get("/api/admin/access", (c) => adminAccess(c, c.get("authSession")));
app.get("/api/admin/organizations", listAdminOrganizations);
app.patch("/api/admin/organizations/:id", requireTrustedOrigin, updateAdminOrganization);
app.patch("/api/admin/organizations/:id/complimentary", requireTrustedOrigin, setAdminComplimentaryAccess);
app.post("/api/admin/organizations/:id/credits", requireTrustedOrigin, grantAdminCredit);
app.delete("/api/admin/organizations/:organizationId/compute-agents/:agentId", requireTrustedOrigin, revokeAdminComputeAgent);
app.get("/api/compute-agent-setup", requireSession, (c) => getComputeAgentSetup(c, c.get("authSession")));
app.post("/api/compute-agent-setup/approve", requireSession, requireTrustedOrigin, (c) => approveComputeAgentSetup(c, c.get("authSession")));

app.use(
  "/assets/*",
  serveStatic({
    root: "./dist/public",
    onFound: (_path, c) => c.header("Cache-Control", "public, max-age=31536000, immutable"),
  }),
);

app.use("/docs/*", async (c, next) => {
  await next();
  if (c.req.path.endsWith(".md") && c.res.headers.get("Content-Type") === "application/octet-stream")
    c.header("Content-Type", "text/markdown; charset=utf-8");
});
app.use("/docs/*", serveStatic({ root: "./dist/public" }));
app.get("/llms.txt", serveStatic({ root: "./dist/public" }));
app.get("/llms-full.txt", serveStatic({ root: "./dist/public" }));
app.use("*", serveStatic({ root: "./dist/public" }));

const spaHtml = await readFile(new URL("./public/index.html", import.meta.url), "utf8");
app.get("*", (c) => c.html(spaHtml));

app.onError((error, c) => {
  if (isBillingError(error)) return c.json({ error: error.message }, 402);
  if (error instanceof HTTPException) return c.json({ error: error.message }, error.status);
  console.error(
    JSON.stringify({ event: "request_failed", message: error.message, path: c.req.path }),
  );
  return c.json({ error: "Internal server error" }, 500);
});
