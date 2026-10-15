import http from "node:http";
import { resolveAccess, activityReporter } from "./resolve-access.mjs";
import { connectContainerLoopback } from "./ssh-loopback.mjs";
import { terminalCommand, sshEnvironment } from './persistent-terminal.mjs';
import { PassThrough } from "node:stream";
import Docker from "dockerode";
import { WebSocket } from "ws";
import { decodeDataFrame, encodeDataFrame, forwardedHeaders } from "./tunnel-protocol.mjs";

const targetServices = {
  preview: { host: "preview-gateway", port: 8081 },
  terminal: { host: "web-terminal", port: 2223 },
};
const docker = new Docker({ socketPath: "/var/run/docker.sock" });

function json(socket, message) {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

function sendData(socket, streamId, data, channel = 1) {
  if (socket.readyState === WebSocket.OPEN) socket.send(encodeDataFrame(streamId, data, channel));
}

function closeStream(streams, streamId) {
  const stream = streams.get(streamId);
  if (!stream) return;
  streams.delete(streamId);
  if (stream.kind === "http") stream.request.destroy();
  else if (stream.kind === "websocket") stream.socket.close();
  else {
    stream.onClose?.();
    stream.io?.destroy();
  }
}

function openHttpStream(tunnel, streams, message, targets) {
  const service = targets[message.target];
  if (!service || message.target !== "preview") throw new Error("Unsupported HTTP tunnel target");
  const streamId = Number(message.stream_id);
  const request = http.request({
    hostname: service.host,
    port: service.port,
    method: typeof message.method === "string" ? message.method : "GET",
    path: typeof message.path === "string" ? message.path : "/",
    headers: forwardedHeaders(message.headers),
  });
  const stream = { kind: "http", request };
  streams.set(streamId, stream);
  request.on("response", (response) => {
    json(tunnel, { type: "response", stream_id: streamId, status: response.statusCode, headers: forwardedHeaders(response.headers) });
    response.on("data", (chunk) => sendData(tunnel, streamId, chunk));
    response.on("end", () => { json(tunnel, { type: "end", stream_id: streamId }); streams.delete(streamId); });
    response.on("error", (error) => { json(tunnel, { type: "close", stream_id: streamId, message: error.message }); streams.delete(streamId); });
  });
  request.on("error", (error) => { json(tunnel, { type: "close", stream_id: streamId, message: error.message }); streams.delete(streamId); });
}

function openWebSocketStream(tunnel, streams, message, targets) {
  const service = targets[message.target];
  if (!service) throw new Error("Unsupported WebSocket tunnel target");
  const streamId = Number(message.stream_id);
  const path = typeof message.path === "string" ? message.path : "/";
  const protocols = Array.isArray(message.protocols) ? message.protocols.filter((value) => typeof value === "string").slice(0, 8) : [];
  const socket = new WebSocket(`ws://${service.host}:${service.port}${path}`, protocols, { headers: forwardedHeaders(message.headers) });
  const stream = { kind: "websocket", socket, queue: [], queuedBytes: 0 };
  streams.set(streamId, stream);
  socket.on("open", () => {
    json(tunnel, { type: "ready", stream_id: streamId });
    for (const queued of stream.queue) socket.send(queued.data, { binary: queued.binary });
    stream.queue = [];
    stream.queuedBytes = 0;
  });
  socket.on("message", (data, binary) => sendData(tunnel, streamId, data, binary ? 1 : 0));
  socket.on("close", () => { json(tunnel, { type: "end", stream_id: streamId }); streams.delete(streamId); });
  socket.on("error", (error) => { json(tunnel, { type: "close", stream_id: streamId, message: error.message }); streams.delete(streamId); });
}

function resolveSsh(controlPlaneUrl, token, nodeId, ticket) {
  return resolveAccess(`${controlPlaneUrl}/api/compute/ssh/resolve`, token, { node_id: nodeId, ticket });
}

async function reportSshEvent(controlPlaneUrl, token, nodeId, sandboxId, event) {
  await fetch(`${controlPlaneUrl}/api/compute/ssh/events`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ node_id: nodeId, sandbox_id: sandboxId, event }),
    signal: AbortSignal.timeout(5000),
  }).catch(() => undefined);
}

async function openSshStream(tunnel, streams, message, connection) {
  const streamId = Number(message.stream_id);
  const stream = { kind: "ssh", io: null, exec: null, queue: [], queuedBytes: 0, closed: false };
  streams.set(streamId, stream);
  try {
    const target = await resolveSsh(connection.controlPlaneUrl, connection.token, connection.nodeId, message.ticket);
    if (!/^[a-f0-9]{12,64}$/i.test(target.runtime_id ?? "")) throw new Error("Invalid SSH runtime target");
    stream.activity = activityReporter(connection.controlPlaneUrl, connection.token, connection.nodeId, target.sandbox_id);
    const container = docker.getContainer(target.runtime_id);
    const details = await container.inspect();
    if (!details.State?.Running || details.Config?.Labels?.["driftverk.server-id"] !== target.sandbox_id)
      throw new Error("SSH runtime target mismatch");
    if (stream.closed || !streams.has(streamId)) return;
    if (message.mode === "tcp") {
      if (message.destination?.host !== "127.0.0.1") throw new Error("Invalid SSH forwarding host");
      const port = Number(message.destination?.port);
      const socket = connectContainerLoopback(details.State.Pid, port);
      socket.on("data", () => stream.activity());
      stream.io = socket;
      socket.on("connect", () => {
        if (!streams.has(streamId)) return socket.destroy();
        socket.on("data", (chunk) => sendData(tunnel, streamId, chunk, 1));
        json(tunnel, { type: "ready", stream_id: streamId });
      });
      socket.on("end", () => { if (streams.has(streamId)) json(tunnel, { type: "end", stream_id: streamId }); streams.delete(streamId); });
      socket.on("close", () => {
        if (streams.has(streamId)) json(tunnel, { type: "close", stream_id: streamId });
        streams.delete(streamId);
      });
      socket.on("error", (error) => { json(tunnel, { type: "close", stream_id: streamId, message: error.message }); streams.delete(streamId); });
      for (const queued of stream.queue) socket.write(queued);
      stream.queue = [];
      stream.queuedBytes = 0;
      return;
    }
    const pty = message.pty && typeof message.pty === "object" ? message.pty : null;
    const command = message.mode === "exec" && typeof message.command === "string"
      ? ["/bin/sh", "-lc", message.command]
      : pty ? terminalCommand('ssh') : ["/bin/sh", "-il"];
    const exec = await container.exec({
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
      Tty: Boolean(pty),
      Cmd: command,
      Env: [
        ...(pty ? [`TERM=${typeof pty.term === "string" ? pty.term.slice(0, 64) : "xterm-256color"}`] : []),
        ...sshEnvironment(details.Config?.Env, target.environment),
      ],
    });
    if (!streams.has(streamId)) return;
    const io = await exec.start({ hijack: true, stdin: true, Tty: Boolean(pty) });
    if (!streams.has(streamId)) {
      io.destroy();
      return;
    }
    io.on("data", () => stream.activity());
    stream.io = io;
    stream.exec = exec;
    if (pty)
      await exec.resize({
        w: Number.isInteger(pty.cols) && pty.cols > 0 ? Math.min(500, Math.max(20, pty.cols)) : 80,
        h: Number.isInteger(pty.rows) && pty.rows > 0 ? Math.min(200, Math.max(5, pty.rows)) : 24,
      });
    if (pty) io.on("data", (chunk) => sendData(tunnel, streamId, chunk, 1));
    else {
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      stdout.on("data", (chunk) => sendData(tunnel, streamId, chunk, 1));
      stderr.on("data", (chunk) => sendData(tunnel, streamId, chunk, 2));
      container.modem.demuxStream(io, stdout, stderr);
    }
    io.on("end", async () => {
      if (!streams.has(streamId)) return;
      const inspected = await exec.inspect().catch(() => ({ ExitCode: 1 }));
      json(tunnel, { type: "exit", stream_id: streamId, code: Number.isInteger(inspected.ExitCode) ? inspected.ExitCode : 1 });
      streams.delete(streamId);
      stream.onClose?.();
    });
    io.on("error", (error) => {
      json(tunnel, { type: "close", stream_id: streamId, message: error.message });
      streams.delete(streamId);
      stream.onClose?.();
    });
    for (const queued of stream.queue) io.write(queued);
    stream.queue = [];
    stream.queuedBytes = 0;
    let disconnected = false;
    stream.onClose = () => {
      if (disconnected) return;
      disconnected = true;
      void reportSshEvent(connection.controlPlaneUrl, connection.token, connection.nodeId, target.sandbox_id, "disconnected");
    };
    json(tunnel, { type: "ready", stream_id: streamId });
    void reportSshEvent(connection.controlPlaneUrl, connection.token, connection.nodeId, target.sandbox_id, "connected");
  } catch (error) {
    streams.delete(streamId);
    json(tunnel, { type: "close", stream_id: streamId, message: error instanceof Error ? error.message : "Could not start SSH session" });
  }
}

function handleControl(tunnel, streams, raw, targets, connection) {
  let message;
  try { message = JSON.parse(raw.toString()); } catch { return; }
  const streamId = Number(message.stream_id);
  if (message.type === "open") {
    if (!Number.isInteger(streamId) || streamId < 1 || streams.has(streamId)) return;
    try {
      if (message.kind === "http") openHttpStream(tunnel, streams, message, targets);
      else if (message.kind === "websocket") openWebSocketStream(tunnel, streams, message, targets);
      else if (message.kind === "ssh") void openSshStream(tunnel, streams, message, connection);
      else throw new Error("Unsupported tunnel stream kind");
    } catch (error) {
      json(tunnel, { type: "close", stream_id: streamId, message: error instanceof Error ? error.message : "Could not open local stream" });
    }
    return;
  }
  const stream = streams.get(streamId);
  if (!stream) return;
  if (message.type === "end" && stream.kind === "http") stream.request.end();
  else if (message.type === "end" && stream.kind === "ssh") stream.io?.end();
  else if (message.type === "resize" && stream.kind === "ssh" && stream.exec && Number.isInteger(message.cols) && message.cols > 0 && Number.isInteger(message.rows) && message.rows > 0)
    void stream.exec.resize({ w: Math.min(500, Math.max(20, message.cols)), h: Math.min(200, Math.max(5, message.rows)) }).catch(() => undefined);
  else if (message.type === "close") closeStream(streams, streamId);
}

function handleData(streams, raw) {
  const frame = decodeDataFrame(raw);
  const stream = frame && streams.get(frame.streamId);
  if (!frame || !stream) return;
  if (stream.kind === "http") {
    stream.request.write(frame.data);
    return;
  }
  if (stream.kind === "ssh") {
    stream.activity?.();
    if (stream.io) stream.io.write(frame.data);
    else if (stream.queuedBytes + frame.data.length <= 1024 * 1024) {
      stream.queue.push(frame.data);
      stream.queuedBytes += frame.data.length;
    }
    return;
  }
  if (stream.socket.readyState === WebSocket.OPEN) stream.socket.send(frame.data, { binary: frame.binary });
  else if (stream.socket.readyState === WebSocket.CONNECTING && stream.queuedBytes + frame.data.length <= 1024 * 1024) {
    stream.queue.push({ data: frame.data, binary: frame.binary });
    stream.queuedBytes += frame.data.length;
  }
}

export function startDataTunnel({ url, token, nodeId, controlPlaneUrl, sandboxNetwork = "bridge", targets = targetServices, onConnectionChange = () => {} }) {
  if (!url) return () => undefined;
  let stopped = false;
  let socket;
  let reconnectTimer;
  let reconnectDelay = 1000;
  const streams = new Map();

  const connect = () => {
    if (stopped) return;
    socket = new WebSocket(url, { headers: { authorization: `Bearer ${token}`, "x-driftverk-node-id": nodeId } });
    const connection = socket;
    let lastPong = Date.now();
    const heartbeat = setInterval(() => {
      if (Date.now() - lastPong > 35000) { onConnectionChange(false); connection.terminate(); }
      else if (connection.readyState === WebSocket.OPEN) connection.ping();
    }, 15000);
    heartbeat.unref();
    connection.on('pong', () => { lastPong = Date.now(); });
    socket.on("open", () => {
      onConnectionChange(true);
      reconnectDelay = 1000;
      console.log(JSON.stringify({ event: "data_tunnel_connected", node_id: nodeId }));
    });
    socket.on("message", (raw, binary) => binary ? handleData(streams, raw) : handleControl(socket, streams, raw, targets, { controlPlaneUrl, token, nodeId, sandboxNetwork }));
    socket.on("close", () => {
      clearInterval(heartbeat);
      onConnectionChange(false);
      for (const streamId of [...streams.keys()]) closeStream(streams, streamId);
      if (stopped) return;
      console.error(JSON.stringify({ event: "data_tunnel_disconnected", node_id: nodeId }));
      reconnectTimer = setTimeout(connect, reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 2, 30_000);
    });
    socket.on("error", (error) => console.error(JSON.stringify({ event: "data_tunnel_error", node_id: nodeId, message: error.message })));
  };

  connect();
  return () => {
    stopped = true;
    clearTimeout(reconnectTimer);
    socket?.close(1000, "Compute agent stopping");
  };
}
