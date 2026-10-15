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

export function forwardedHeaders(headers) {
  const blocked = new Set(["connection", "keep-alive", "proxy-connection", "transfer-encoding", "upgrade", "sec-websocket-accept"]);
  return Object.fromEntries(Object.entries(headers ?? {}).filter(([name, value]) => {
    const normalized = name.toLowerCase();
    return value !== undefined && !blocked.has(normalized) && !normalized.startsWith("sec-websocket-");
  }));
}
