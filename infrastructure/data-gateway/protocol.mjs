import { createHmac, timingSafeEqual } from "node:crypto";

const DATA_FRAME_HEADER_SIZE = 6;

export function encodeDataFrame(streamId, data, channel = 1) {
  if (!Number.isInteger(streamId) || streamId < 1 || streamId > 0xffffffff)
    throw new Error("Invalid tunnel stream ID");
  const payload = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const frame = Buffer.allocUnsafe(DATA_FRAME_HEADER_SIZE + payload.length);
  frame[0] = 1;
  if (!Number.isInteger(channel) || channel < 0 || channel > 255) throw new Error("Invalid tunnel data channel");
  frame[1] = channel;
  frame.writeUInt32BE(streamId, 2);
  payload.copy(frame, DATA_FRAME_HEADER_SIZE);
  return frame;
}

export function decodeDataFrame(frame) {
  const value = Buffer.isBuffer(frame) ? frame : Buffer.from(frame);
  if (value.length < DATA_FRAME_HEADER_SIZE || value[0] !== 1) return null;
  const streamId = value.readUInt32BE(2);
  if (!streamId) return null;
  return { streamId, channel: value[1], binary: value[1] === 1, data: value.subarray(DATA_FRAME_HEADER_SIZE) };
}

export function verifySignedToken(token, secret) {
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [payload, suppliedSignature] = parts;
  if (!payload || !suppliedSignature) return null;
  const expected = createHmac("sha256", secret).update(payload).digest();
  let supplied;
  try { supplied = Buffer.from(suppliedSignature, "base64url"); } catch { return null; }
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return null;
  try {
    const grant = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return grant?.expiresAt > Date.now() ? grant : null;
  } catch {
    return null;
  }
}

export function requestToken(request, previewSecret) {
  const queryToken = new URL(request.url ?? "/", "http://gateway").searchParams.get("token");
  const cookieToken = String(request.headers.cookie ?? "")
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith("dv_preview="))
    ?.slice(11);
  // Applications may use their own ?token (for example Phoenix sockets).
  // Only a signed preview grant may override the preview session cookie.
  return (queryToken && verifySignedToken(queryToken, previewSecret) ? queryToken : cookieToken) || queryToken || "";
}

export function forwardedHeaders(headers) {
  const blocked = new Set(["connection", "keep-alive", "proxy-connection", "transfer-encoding", "upgrade"]);
  return Object.fromEntries(Object.entries(headers).filter(([name, value]) => value !== undefined && !blocked.has(name.toLowerCase())));
}
