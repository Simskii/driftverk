import { installationMode } from "./installation.js";
import { LEGAL_ORIGIN, TERMS_VERSION } from "./legal.js";
function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function boolean(name: string, fallback: boolean): boolean {
  const value = process.env[name]?.trim().toLowerCase();
  if (!value) return fallback;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${name} must be true or false`);
}

const mode = installationMode(process.env.INSTALLATION_MODE);
const selfHosted = mode === "self-hosted";
const publicOrigin = new URL(required("BETTER_AUTH_URL"));
const nodeEnv = process.env.NODE_ENV ?? "development";
const emailMode = process.env.EMAIL_MODE ?? "console";
if (emailMode !== "console" && emailMode !== "resend")
  throw new Error("EMAIL_MODE must be console or resend");

export const config = {
  nodeEnv,
  installationMode: mode,
  selfHosted,
  termsVersion: selfHosted ? (process.env.OPERATOR_TERMS_VERSION?.trim() || null) : TERMS_VERSION,
  termsUrl: selfHosted ? (process.env.OPERATOR_TERMS_URL?.trim() || null) : `${LEGAL_ORIGIN}/en/terms`,
  privacyUrl: selfHosted ? (process.env.OPERATOR_PRIVACY_URL?.trim() || null) : `${LEGAL_ORIGIN}/en/privacy`,
  port: Number(process.env.PORT ?? 3000),
  databaseUrl: required("DATABASE_URL"),
  betterAuthUrl: required("BETTER_AUTH_URL"),
  betterAuthSecret: required("BETTER_AUTH_SECRET"),
  secretEncryptionKeys: required("SECRET_ENCRYPTION_KEYS"),
  previewTokenSecret: required("PREVIEW_TOKEN_SECRET"),
  terminalTokenSecret: required("TERMINAL_TOKEN_SECRET"),
  sshTokenSecret: required("SSH_TOKEN_SECRET"),
  trustedOrigins: (process.env.TRUSTED_ORIGINS ?? required("BETTER_AUTH_URL"))
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean),
  allowSignUp: boolean("AUTH_ALLOW_SIGN_UP", nodeEnv !== "production"),
  requireEmailVerification: boolean("AUTH_REQUIRE_EMAIL_VERIFICATION", true),
  allowUntrustedCode: boolean("ALLOW_UNTRUSTED_CODE", false),
  emailMode,
  resendApiKey: process.env.RESEND_API_KEY?.trim() ?? "",
  emailFrom: process.env.EMAIL_FROM?.trim() ?? (selfHosted ? "" : "Driftverk <hello@driftverk.com>"),
  signupNotificationEmail: process.env.SIGNUP_NOTIFICATION_EMAIL?.trim() || "",
  computeAgentToken: required("COMPUTE_AGENT_TOKEN"),
  managedComputeNodeId: process.env.MANAGED_COMPUTE_NODE_ID?.trim() || "compute-1",
  defaultSandboxImage: process.env.DEFAULT_SANDBOX_IMAGE?.trim() || "driftverk-dev:1",
  sshPublicHost: process.env.SSH_PUBLIC_HOST?.trim() || (selfHosted ? publicOrigin.hostname : "ssh.app.driftverk.com"),
  sshPublicPort: Number(process.env.SSH_PUBLIC_PORT ?? 2222),
  previewDomain: process.env.PREVIEW_DOMAIN?.trim() || (selfHosted ? `preview.${publicOrigin.hostname}` : "preview.app.driftverk.com"),
  githubAppClientId: process.env.GITHUB_APP_CLIENT_ID?.trim() || "",
  githubAppClientSecret: process.env.GITHUB_APP_CLIENT_SECRET?.trim() || "",
  githubAppSlug: process.env.GITHUB_APP_SLUG?.trim() || "",
};

if ([config.githubAppClientId, config.githubAppClientSecret, config.githubAppSlug].some(Boolean) &&
    ![config.githubAppClientId, config.githubAppClientSecret, config.githubAppSlug].every(Boolean))
  throw new Error("GITHUB_APP_CLIENT_ID, GITHUB_APP_CLIENT_SECRET and GITHUB_APP_SLUG must be configured together");

if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535)
  throw new Error("PORT must be a valid TCP port");
if (config.betterAuthSecret.length < 32)
  throw new Error("BETTER_AUTH_SECRET must contain at least 32 characters");
if (config.previewTokenSecret.length < 32)
  throw new Error("PREVIEW_TOKEN_SECRET must contain at least 32 characters");
if (config.terminalTokenSecret.length < 32)
  throw new Error("TERMINAL_TOKEN_SECRET must contain at least 32 characters");
if (config.sshTokenSecret.length < 32)
  throw new Error("SSH_TOKEN_SECRET must contain at least 32 characters");
if (config.computeAgentToken.length < 32)
  throw new Error("COMPUTE_AGENT_TOKEN must contain at least 32 characters");
if (!/^[A-Za-z0-9._-]{1,80}$/.test(config.managedComputeNodeId))
  throw new Error("MANAGED_COMPUTE_NODE_ID must be a valid compute node ID");
if (!Number.isInteger(config.sshPublicPort) || config.sshPublicPort < 1 || config.sshPublicPort > 65535)
  throw new Error("SSH_PUBLIC_PORT must be a valid TCP port");
if (config.emailMode === "resend" && !config.resendApiKey)
  throw new Error("RESEND_API_KEY is required when EMAIL_MODE=resend");

if (Boolean(config.termsUrl) !== Boolean(config.termsVersion)) throw new Error("OPERATOR_TERMS_URL and OPERATOR_TERMS_VERSION must be configured together");
for (const url of [config.termsUrl, config.privacyUrl]) {
  if (url && !["https:", "http:"].includes(new URL(url).protocol)) throw new Error("Operator legal URLs must use HTTP or HTTPS");
}
if (config.emailMode === "resend" && !config.emailFrom) throw new Error("EMAIL_FROM is required when EMAIL_MODE=resend");
