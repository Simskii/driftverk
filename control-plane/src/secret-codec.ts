import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const encryptedValuePrefix = "dvenc:v2:";
const keyIdPattern = /^[A-Za-z0-9_-]{1,40}$/;

export type SecretKeyring = {
  activeKeyId: string;
  keys: ReadonlyMap<string, Buffer>;
};

function decodeKey(value: string): Buffer {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value))
    throw new Error("Secret encryption keys must be base64 encoded");
  const key = Buffer.from(value, "base64");
  if (key.length !== 32) throw new Error("Secret encryption keys must decode to exactly 32 bytes");
  return key;
}

export function parseSecretKeyring(value: string): SecretKeyring {
  const keys = new Map<string, Buffer>();
  for (const entry of value.split(",").map((item) => item.trim()).filter(Boolean)) {
    const separator = entry.indexOf("=");
    const keyId = entry.slice(0, separator);
    const encodedKey = entry.slice(separator + 1);
    if (separator < 1 || !keyIdPattern.test(keyId) || !encodedKey)
      throw new Error("SECRET_ENCRYPTION_KEYS must use key-id=base64-key entries");
    if (keys.has(keyId)) throw new Error(`Duplicate secret encryption key ID: ${keyId}`);
    keys.set(keyId, decodeKey(encodedKey));
  }
  const activeKeyId = keys.keys().next().value as string | undefined;
  if (!activeKeyId) throw new Error("SECRET_ENCRYPTION_KEYS must contain at least one key");
  return { activeKeyId, keys };
}

export function encryptWithKeyring(
  value: string,
  keyring: SecretKeyring,
  context: string,
): { encryptedValue: string; iv: string } {
  if (!context) throw new Error("Secret encryption context is required");
  const iv = randomBytes(12);
  const key = keyring.keys.get(keyring.activeKeyId);
  if (!key) throw new Error("The active secret encryption key is unavailable");
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(context, "utf8"));
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final(), cipher.getAuthTag()]);
  return {
    encryptedValue: `${encryptedValuePrefix}${keyring.activeKeyId}:${encrypted.toString("base64")}`,
    iv: iv.toString("base64"),
  };
}

export function decryptWithKeyring(
  encryptedValue: string,
  ivValue: string,
  keyring: SecretKeyring,
  context: string,
  legacyKey?: Buffer,
): string {
  let key = legacyKey;
  let encodedPayload = encryptedValue;
  if (encryptedValue.startsWith(encryptedValuePrefix)) {
    if (!context) throw new Error("Secret encryption context is required");
    const remainder = encryptedValue.slice(encryptedValuePrefix.length);
    const separator = remainder.indexOf(":");
    const keyId = remainder.slice(0, separator);
    encodedPayload = remainder.slice(separator + 1);
    if (separator < 1 || !keyIdPattern.test(keyId) || !encodedPayload)
      throw new Error("Encrypted secret payload is malformed");
    key = keyring.keys.get(keyId);
    if (!key) throw new Error(`Secret encryption key is unavailable: ${keyId}`);
  }
  if (!key) throw new Error("A legacy secret encryption key is required for this value");

  const payload = Buffer.from(encodedPayload, "base64");
  const iv = Buffer.from(ivValue, "base64");
  if (payload.length < 17 || iv.length !== 12) throw new Error("Encrypted secret payload is malformed");
  const tag = payload.subarray(payload.length - 16);
  const ciphertext = payload.subarray(0, payload.length - 16);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  if (encryptedValue.startsWith(encryptedValuePrefix))
    decipher.setAAD(Buffer.from(context, "utf8"));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}
