import { createHmac, timingSafeEqual } from "node:crypto";

export function signWebhook(secret: string, eventId: string, timestamp: number, body: string): string {
  const encodedKey = secret.startsWith("whsec_") ? secret.slice(6) : secret;
  const key = Buffer.from(encodedKey, "base64");
  const signature = createHmac("sha256", key)
    .update(`${eventId}.${timestamp}.${body}`)
    .digest("base64");
  return `v1,${signature}`;
}

export function verifyWebhookSignature(secret: string, signature: string, eventId: string, timestamp: number, body: string): boolean {
  const expected = Buffer.from(signWebhook(secret, eventId, timestamp, body));
  const supplied = Buffer.from(signature);
  return expected.length === supplied.length && timingSafeEqual(expected, supplied);
}
