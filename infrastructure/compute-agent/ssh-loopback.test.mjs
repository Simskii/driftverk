import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import net from "node:net";
import test from "node:test";
import { connectContainerLoopback } from "./ssh-loopback.mjs";

// Exercise the real relay process locally; namespace entry is checked on Linux.
function localRelay(command, args, options) {
  assert.equal(command, "nsenter");
  assert.deepEqual(args.slice(0, 3), ["--target", "123", "--net"]);
  return spawn(args[3], args.slice(4), options);
}

test("SSH relay preserves binary data and half-close responses", { timeout: 10000 }, async () => {
  const payload = Buffer.from([0, 255, 1, 128, 10]);
  const server = net.createServer({ allowHalfOpen: true }, (client) => {
    const received = [];
    client.on("data", (chunk) => received.push(chunk));
    client.on("end", () => client.end(Buffer.concat(received)));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const socket = connectContainerLoopback(123, server.address().port, localRelay);
  try {
    await once(socket, "connect");
    const received = [];
    socket.on("data", (chunk) => received.push(chunk));
    socket.end(payload);
    await once(socket, "end");
    assert.deepEqual(Buffer.concat(received), payload);
  } finally {
    socket.destroy();
    server.close();
  }
});

test("SSH relay rejects invalid namespace and port targets before spawning", () => {
  const unexpectedSpawn = () => assert.fail("must not spawn");
  for (const pid of [0, -1, undefined, "123"]) assert.throws(() => connectContainerLoopback(pid, 80, unexpectedSpawn));
  for (const port of [0, 65536, "80"]) assert.throws(() => connectContainerLoopback(123, port, unexpectedSpawn));
});
