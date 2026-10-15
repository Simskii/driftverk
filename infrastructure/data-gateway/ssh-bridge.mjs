import http from "node:http";
import { timingSafeEqual } from "node:crypto";
import { EventEmitter } from "node:events";
import { WebSocket, WebSocketServer } from "ws";

// Private, authenticated transport from the SSH frontend. One socket per SSH
// channel; binary messages begin with 1 (stdout/input) or 2 (stderr).
export function createSshBridge({ secret, open, resize }) {
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
  const server = http.createServer((_request, response) => response.writeHead(404).end());
  server.on("upgrade", (request, socket, head) => {
    const supplied = Buffer.from(request.headers.authorization ?? "");
    const expected = Buffer.from(`Bearer ${secret}`);
    if (request.url !== "/ssh" || supplied.length !== expected.length || !timingSafeEqual(supplied, expected))
      return socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
    if (sockets.clients.size >= 4096)
      return socket.end("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n");
    sockets.handleUpgrade(request, socket, head, (ws) => sockets.emit("connection", ws));
  });
  sockets.on("connection", (socket) => {
    let channel;
    let streamId;
    let nodeId;
    let started = false;
    let ended = false;
    let alive = true;
    const timer = setTimeout(() => socket.close(1008, "Missing stream request"), 5000);
    const heartbeat = setInterval(() => {
      if (!alive) return socket.terminate();
      alive = false;
      socket.ping();
    }, 20_000);
    heartbeat.unref();
    const send = (value, binary = false) => {
      if (socket.readyState !== WebSocket.OPEN) return;
      if (socket.bufferedAmount > 1024 * 1024) return socket.terminate();
      socket.send(binary ? value : JSON.stringify(value), { binary });
    };
    socket.on("pong", () => { alive = true; });
    socket.on("error", () => socket.terminate());
    socket.on("close", () => {
      clearTimeout(timer);
      clearInterval(heartbeat);
      channel?.emit("close");
    });
    socket.on("message", async (raw, binary) => {
      if (binary) {
        if (!channel || ended || raw.length < 1 || raw[0] !== 1) return socket.close(1008, "Invalid stream data");
        channel.emit("data", raw.subarray(1));
        return;
      }
      let message;
      try { message = JSON.parse(raw.toString()); } catch { return socket.close(1008, "Invalid stream message"); }
      if (!message || typeof message !== "object") return socket.close(1008, "Invalid stream message");
      if (!started) {
        started = true;
        clearTimeout(timer);
        const pty = message.pty;
        if (message.type !== "open" || typeof message.node_id !== "string" || typeof message.ticket !== "string"
          || !["shell", "exec", "tcp"].includes(message.mode)
          || (message.mode === "exec" && (typeof message.command !== "string" || Buffer.byteLength(message.command) > 16 * 1024))
          || (pty && (typeof pty.term !== "string" || !Number.isInteger(pty.cols) || pty.cols < 1 || pty.cols > 500 || !Number.isInteger(pty.rows) || pty.rows < 1 || pty.rows > 200))
          || (message.mode === "tcp" && (message.destination?.host !== "127.0.0.1" || !Number.isInteger(message.destination?.port) || message.destination.port < 1 || message.destination.port > 65535)))
          return socket.close(1008, "Invalid stream request");
        nodeId = message.node_id;
        channel = new EventEmitter();
        channel.write = (data) => send(Buffer.concat([Buffer.from([1]), Buffer.from(data)]), true);
        channel.stderr = { write: (data) => send(Buffer.concat([Buffer.from([2]), Buffer.from(data)]), true) };
        channel.exit = (code) => send({ type: "exit", code });
        channel.end = () => socket.close(1000);
        channel.close = channel.end;
        try {
          streamId = await open({ node_id: nodeId, ticket: message.ticket }, channel, message);
          if (!streamId) socket.close(1011, "Stream unavailable");
          // The socket may close while the stream is being registered.
          if (socket.readyState !== WebSocket.OPEN) channel.emit("close");
        } catch { socket.close(1011, "Stream unavailable"); }
        return;
      }
      if (!channel) return socket.close(1008, "Stream not open");
      if (message.type === "end" && !ended) {
        ended = true;
        channel.emit("end");
      } else if (message.type === "resize" && Number.isInteger(message.cols) && message.cols > 0 && Number.isInteger(message.rows) && message.rows > 0) {
        resize(streamId, nodeId, Math.min(message.cols, 500), Math.min(message.rows, 200));
      } else socket.close(1008, "Invalid stream control");
    });
  });
  return { server, clients: sockets.clients };
}
