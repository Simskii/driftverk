import assert from "node:assert/strict";
import test from "node:test";
import { decodeDataFrame, encodeDataFrame, forwardedHeaders } from "./tunnel-protocol.mjs";

test("round trips tunnel frames without changing payload bytes", () => {
  const payload = Buffer.from([0, 1, 2, 255]);
  const decoded = decodeDataFrame(encodeDataFrame(7, payload, 1));
  assert.equal(decoded.streamId, 7);
  assert.equal(decoded.binary, true);
  assert.equal(decoded.channel, 1);
  assert.deepEqual(decoded.data, payload);
});

test("removes hop by hop and WebSocket handshake headers before forwarding", () => {
  assert.deepEqual(forwardedHeaders({ host: "preview.test", connection: "upgrade", "sec-websocket-key": "secret", "x-test": "yes" }), {
    host: "preview.test",
    "x-test": "yes",
  });
});
