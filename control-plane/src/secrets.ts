import { createHash } from "node:crypto";
import { config } from "./config.js";
import { decryptWithKeyring, encryptWithKeyring, parseSecretKeyring } from "./secret-codec.js";

const keyring = parseSecretKeyring(config.secretEncryptionKeys);
const legacyKey = createHash("sha256").update(config.betterAuthSecret).digest();

export const secretContext = {
  agentConnection: (userId: string) => `user:${userId}:agent:codex`,
  organization: (organizationId: string, name: string) => `organization:${organizationId}:secret:${name}`,
  userGithub: (userId: string) => `user:${userId}:github:token`,
  github: (organizationId: string) => `organization:${organizationId}:github:token`,
  environment: (organizationId: string, sandboxId: string, name: string) =>
    `organization:${organizationId}:environment:${sandboxId}:variable:${name}`,
  registry: (organizationId: string, registryId: string) =>
    `organization:${organizationId}:registry:${registryId}:password`,
  webhook: (organizationId: string, webhookId: string) =>
    `organization:${organizationId}:webhook:${webhookId}:signing-secret`,
};

export function encryptSecret(value: string, context: string): { encryptedValue: string; iv: string } {
  return encryptWithKeyring(value, keyring, context);
}

export function decryptSecret(encryptedValue: string, ivValue: string, context: string): string {
  return decryptWithKeyring(encryptedValue, ivValue, keyring, context, legacyKey);
}
