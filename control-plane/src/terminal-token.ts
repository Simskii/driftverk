import { createHmac, timingSafeEqual } from "node:crypto";

export type TerminalGrant = { agent?: boolean; userId?: string; sandboxId: string; nodeId: string; expiresAt: number; nonce: string };

export function createTerminalToken(grant: TerminalGrant, secret: string): string {
  const payload = Buffer.from(JSON.stringify(grant)).toString("base64url");
  const signature = createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

export function verifyTerminalToken(token: string, secret: string): TerminalGrant | null {
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [payload, suppliedSignature] = parts;
  if (!payload || !suppliedSignature) return null;
  const expected = createHmac("sha256", secret).update(payload).digest();
  let supplied: Buffer;
  try { supplied = Buffer.from(suppliedSignature, "base64url"); } catch { return null; }
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return null;
  try {
    const grant = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as TerminalGrant;
    if (!grant.sandboxId || !grant.nodeId || !grant.nonce || grant.expiresAt <= Date.now()) return null;
    return grant;
  } catch { return null; }
}
