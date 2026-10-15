import { createHmac, timingSafeEqual } from "node:crypto";

export type PreviewGrant = { userId?: string | undefined; sandboxId: string; nodeId: string; port: number; expiresAt: number };

export function createPreviewToken(grant: PreviewGrant, secret: string): string {
  const payload = Buffer.from(JSON.stringify(grant)).toString("base64url");
  const signature = createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

export function verifyPreviewToken(token: string, secret: string): PreviewGrant | null {
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [payload, suppliedSignature] = parts;
  if (!payload || !suppliedSignature) return null;
  const expectedSignature = createHmac("sha256", secret).update(payload).digest();
  let supplied: Buffer;
  try { supplied = Buffer.from(suppliedSignature, "base64url"); } catch { return null; }
  if (supplied.length !== expectedSignature.length || !timingSafeEqual(supplied, expectedSignature)) return null;
  try {
    const grant = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as PreviewGrant;
    if (!grant.sandboxId || !grant.nodeId || !Number.isInteger(grant.port) || grant.port < 1 || grant.port > 65535 || grant.expiresAt <= Date.now()) return null;
    return grant;
  } catch { return null; }
}
