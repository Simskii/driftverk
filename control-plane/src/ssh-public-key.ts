import { createHash } from "node:crypto";

const supportedAlgorithms = new Set([
  "ssh-ed25519",
  "ssh-rsa",
  "ecdsa-sha2-nistp256",
  "ecdsa-sha2-nistp384",
  "ecdsa-sha2-nistp521",
]);

export function parsePublicKey(value: unknown): { publicKey: string; fingerprint: string } | null {
  const parts = String(value ?? "").trim().split(/\s+/);
  if (parts.length < 2 || !supportedAlgorithms.has(parts[0] ?? "")) return null;
  const algorithm = parts[0]!;
  const encoded = parts[1]!;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) return null;
  const keyData = Buffer.from(encoded, "base64");
  if (keyData.length < 32 || keyData.length > 16_384 || keyData.toString("base64").replace(/=+$/, "") !== encoded.replace(/=+$/, "")) return null;
  return {
    publicKey: `${algorithm} ${encoded}`,
    fingerprint: `SHA256:${createHash("sha256").update(keyData).digest("base64").replace(/=+$/, "")}`,
  };
}
