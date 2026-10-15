// Observe frame headers without buffering payloads or altering the proxy stream.
// This also works with compressed frames: only the opcode matters for activity.
export function websocketActivity(onActivity) {
  let header = Buffer.alloc(0);
  let remaining = 0n;
  let applicationData = false;
  return chunk => {
    let offset = 0;
    while (offset < chunk.length) {
      if (remaining > 0n) {
        const count = Number(remaining < BigInt(chunk.length - offset) ? remaining : BigInt(chunk.length - offset));
        if (applicationData && count) onActivity();
        remaining -= BigInt(count);
        offset += count;
        continue;
      }
      const needed = header.length < 2 ? 2 : 2 + ((header[1] & 127) === 126 ? 2 : (header[1] & 127) === 127 ? 8 : 0) + (header[1] & 128 ? 4 : 0);
      const count = Math.min(needed - header.length, chunk.length - offset);
      header = Buffer.concat([header, chunk.subarray(offset, offset + count)]);
      offset += count;
      if (header.length < 2) continue;
      const lengthCode = header[1] & 127;
      const fullHeader = 2 + (lengthCode === 126 ? 2 : lengthCode === 127 ? 8 : 0) + (header[1] & 128 ? 4 : 0);
      if (header.length < fullHeader) continue;
      remaining = lengthCode === 126 ? BigInt(header.readUInt16BE(2)) : lengthCode === 127 ? header.readBigUInt64BE(2) : BigInt(lengthCode);
      const opcode = header[0] & 15;
      applicationData = opcode === 0 || opcode === 1 || opcode === 2;
      if (applicationData && remaining === 0n) onActivity();
      header = Buffer.alloc(0);
    }
  };
}
