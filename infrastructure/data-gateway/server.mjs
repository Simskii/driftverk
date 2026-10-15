import http from "node:http";
import { createSshBridge } from "./ssh-bridge.mjs";
import { WebSocket, WebSocketServer } from "ws";
import { decodeDataFrame, encodeDataFrame, forwardedHeaders, requestToken, verifySignedToken } from "./protocol.mjs";
import { previewStatusPage } from "./preview-status-page.mjs";

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const port = Number(process.env.PORT ?? 3001);
const controlPlaneUrl = required("CONTROL_PLANE_URL").replace(/\/$/, "");
const publicAppUrl = (process.env.PUBLIC_APP_URL?.trim() || "https://app.driftverk.com").replace(/\/$/, "");
const previewTokenSecret = required("PREVIEW_TOKEN_SECRET");
const terminalTokenSecret = required("TERMINAL_TOKEN_SECRET");
const previewDomain = process.env.PREVIEW_DOMAIN?.trim() || "preview.app.driftverk.com";
const maxStreamsPerAgent = Number(process.env.MAX_STREAMS_PER_AGENT ?? 512);
const sshBridgePort = Number(process.env.SSH_BRIDGE_PORT ?? 3002);
const sshBridgeSecret = required("SSH_BRIDGE_SECRET");

if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("PORT must be a valid TCP port");
if (previewTokenSecret.length < 32 || terminalTokenSecret.length < 32) throw new Error("Tunnel token secrets must contain at least 32 characters");
if (!Number.isInteger(maxStreamsPerAgent) || maxStreamsPerAgent < 1) throw new Error("MAX_STREAMS_PER_AGENT must be a positive integer");
if (!Number.isInteger(sshBridgePort) || sshBridgePort < 1 || sshBridgePort > 65535) throw new Error("SSH_BRIDGE_PORT must be a valid TCP port");
if (sshBridgeSecret.length < 32) throw new Error("SSH_BRIDGE_SECRET must contain at least 32 characters");

const agentServer = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024 * 1024 });
const clientServer = new WebSocketServer({
  noServer: true,
  maxPayload: 8 * 1024 * 1024,
  handleProtocols: (protocols) => protocols.values().next().value,
});
const agents = new Map();
const streams = new Map();
let nextStreamId = 1;

function sendPreviewStatus(response, status, options, headers = {}) {
  response.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
    "referrer-policy": "no-referrer",
    ...headers,
  });
  response.end(previewStatusPage(options));
}

function json(socket, message) {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

function nextId() {
  for (let attempts = 0; attempts < 0xffffffff; attempts += 1) {
    const candidate = nextStreamId;
    nextStreamId = nextStreamId >= 0xffffffff ? 1 : nextStreamId + 1;
    if (!streams.has(candidate)) return candidate;
  }
  throw new Error("No tunnel stream IDs are available");
}

function removeStream(streamId) {
  const stream = streams.get(streamId);
  if (!stream) return;
  streams.delete(streamId);
  stream.agent.streams.delete(streamId);
  clearTimeout(stream.openTimer);
}

function failStream(streamId, message = "The compute connection closed") {
  const stream = streams.get(streamId);
  if (!stream) return;
  json(stream.agent.socket, { type: "close", stream_id: streamId });
  removeStream(streamId);
  if (stream.kind === "http") {
    if (!stream.response.headersSent) return sendPreviewStatus(stream.response, 502, {
      title: "Preview connection interrupted",
      message: "The connection to the environment closed before the app responded.",
      actionHref: ".",
      actionLabel: "Try again",
      active: true,
    });
    stream.response.end(message);
  } else if (stream.kind === "websocket" && stream.socket.readyState === WebSocket.OPEN) {
    stream.socket.close(1011, message.slice(0, 120));
  } else if (stream.kind === "ssh") {
    if (stream.mode !== "tcp") {
      stream.channel.stderr.write(`${message}\n`);
      stream.channel.exit(255);
    }
    stream.channel.end();
  }
}

function openStream(agent, stream) {
  if (agent.streams.size >= maxStreamsPerAgent) throw new Error("The compute agent has too many active streams");
  const streamId = nextId();
  stream.id = streamId;
  stream.agent = agent;
  stream.openTimer = setTimeout(() => failStream(streamId, "The compute gateway did not accept the stream"), 60_000);
  streams.set(streamId, stream);
  agent.streams.add(streamId);
  json(agent.socket, {
    type: "open",
    stream_id: streamId,
    kind: stream.kind,
    target: stream.target,
    method: stream.method,
    path: stream.path,
    headers: stream.headers,
    protocols: stream.protocols,
    ticket: stream.ticket,
    mode: stream.mode,
    command: stream.command,
    pty: stream.pty,
    destination: stream.destination,
  });
  return streamId;
}

function previewGrant(request) {
  const host = String(request.headers.host ?? "").split(":")[0].toLowerCase();
  const suffix = `.${previewDomain}`;
  if (!host.endsWith(suffix)) return null;
  const match = host.slice(0, -suffix.length).match(/^(\d{1,5})-([a-z0-9-]+)$/);
  if (!match) return null;
  const token = requestToken(request, previewTokenSecret);
  const grant = verifySignedToken(token, previewTokenSecret);
  const requestedPort = Number(match[1]);
  if (!grant || grant.port !== requestedPort || typeof grant.nodeId !== "string") return { error: token ? 403 : 401 };
  return { nodeId: grant.nodeId, requestedPort };
}

function terminalGrant(request) {
  const url = new URL(request.url ?? "/", "http://gateway");
  if (url.pathname !== "/api/terminal") return null;
  const grant = verifySignedToken(url.searchParams.get("token") ?? "", terminalTokenSecret);
  if (!grant || typeof grant.nodeId !== "string") return { error: 403 };
  return { nodeId: grant.nodeId };
}

function route(request) {
  return terminalGrant(request) ?? previewGrant(request);
}

function sendData(agent, streamId, data, channel = 1) {
  if (agent.socket.readyState !== WebSocket.OPEN) return;
  if (agent.socket.bufferedAmount > 16 * 1024 * 1024) {
    failStream(streamId, "The compute tunnel is congested");
    return;
  }
  agent.socket.send(encodeDataFrame(streamId, data, channel));
}

function handleAgentMessage(agent, raw, binary) {
  if (binary) {
    const frame = decodeDataFrame(raw);
    const stream = frame && streams.get(frame.streamId);
    if (!frame || !stream || stream.agent !== agent) return;
    if (stream.kind === "http") stream.response.write(frame.data);
    else if (stream.kind === "websocket" && stream.socket.readyState === WebSocket.OPEN) stream.socket.send(frame.data, { binary: frame.binary });
    else if (stream.kind === "ssh") (frame.channel === 2 ? stream.channel.stderr : stream.channel).write(frame.data);
    return;
  }
  let message;
  try { message = JSON.parse(raw.toString()); } catch { return; }
  const streamId = Number(message.stream_id);
  const stream = streams.get(streamId);
  if (!stream || stream.agent !== agent) return;
  if (message.type === "ready") {
    clearTimeout(stream.openTimer);
    stream.openTimer = undefined;
    stream.ready = true;
    for (const queued of stream.queue ?? []) sendData(agent, streamId, queued.data, queued.channel);
    stream.queue = [];
    if (stream.inputEnded) json(agent.socket, { type: "end", stream_id: streamId });
  } else if (message.type === "response" && stream.kind === "http") {
    clearTimeout(stream.openTimer);
    stream.openTimer = undefined;
    const status = Number(message.status);
    if (!stream.response.headersSent) stream.response.writeHead(Number.isInteger(status) && status >= 100 && status <= 599 ? status : 502, forwardedHeaders(message.headers ?? {}));
  } else if (message.type === "end") {
    removeStream(streamId);
    if (stream.kind === "http") stream.response.end();
    else if (stream.kind === "websocket" && stream.socket.readyState === WebSocket.OPEN) stream.socket.close(1000, "Remote stream closed");
    else if (stream.kind === "ssh") stream.channel.end();
  } else if (message.type === "exit" && stream.kind === "ssh") {
    removeStream(streamId);
    stream.channel.exit(Number.isInteger(message.code) ? message.code : 1);
    stream.channel.end();
  } else if (message.type === "close") {
    failStream(streamId, typeof message.message === "string" ? message.message : "The remote stream closed");
  }
}

async function authenticateAgent(request) {
  const authorization = request.headers.authorization;
  const nodeId = String(request.headers["x-driftverk-node-id"] ?? "").trim();
  if (!authorization?.startsWith("Bearer ") || !/^[A-Za-z0-9._-]{1,80}$/.test(nodeId)) return null;
  const response = await fetch(`${controlPlaneUrl}/api/compute/tunnel/authorize`, {
    method: "POST",
    headers: { authorization, "content-type": "application/json" },
    body: JSON.stringify({ node_id: nodeId }),
    signal: AbortSignal.timeout(5000),
  });
  return response.ok ? nodeId : null;
}

agentServer.on("connection", (socket, _request, nodeId) => {
  const previous = agents.get(nodeId);
  if (previous) previous.socket.close(1012, "A newer agent connection replaced this tunnel");
  const agent = { nodeId, socket, streams: new Set(), alive: true };
  agents.set(nodeId, agent);
  socket.on("pong", () => { agent.alive = true; });
  socket.on("message", (raw, binary) => handleAgentMessage(agent, raw, binary));
  socket.on("close", () => {
    if (agents.get(nodeId) === agent) agents.delete(nodeId);
    for (const streamId of [...agent.streams]) failStream(streamId);
  });
  console.info(JSON.stringify({ event: "data_tunnel_connected", node_id: nodeId }));
});

clientServer.on("connection", (socket, request, routed) => {
  const agent = agents.get(routed.nodeId);
  if (!agent) return socket.close(1013, "The compute agent is offline");
  const target = terminalGrant(request) ? "terminal" : "preview";
  let streamId;
  try {
    const protocols = String(request.headers["sec-websocket-protocol"] ?? "").split(",").map((value) => value.trim()).filter(Boolean);
    streamId = openStream(agent, { kind: "websocket", target, path: request.url ?? "/", headers: forwardedHeaders(request.headers), protocols, socket, queue: [], ready: false });
  } catch (error) {
    socket.close(1013, error instanceof Error ? error.message.slice(0, 120) : "The compute agent is unavailable");
    return;
  }
  socket.on("message", (data, binary) => {
    const stream = streams.get(streamId);
    if (!stream) return;
    if (!stream.ready) {
      const size = stream.queue.reduce((total, item) => total + item.data.length, 0);
      if (size + data.length > 1024 * 1024) return failStream(streamId, "The pending stream exceeded its limit");
      stream.queue.push({ data: Buffer.from(data), channel: binary ? 1 : 0 });
      return;
    }
    sendData(agent, streamId, data, binary ? 1 : 0);
  });
  socket.on("close", () => {
    if (!streams.has(streamId)) return;
    json(agent.socket, { type: "close", stream_id: streamId });
    removeStream(streamId);
  });
});

function openSshChannel(authorized, channel, mode, command, pty) {
  const agent = agents.get(authorized.node_id);
  if (!agent) {
    channel.stderr.write("The compute agent is offline\n");
    channel.exit(255);
    channel.end();
    return null;
  }
  let streamId;
  try {
    streamId = openStream(agent, {
      kind: "ssh",
      target: "ssh",
      ticket: authorized.ticket,
      mode,
      command,
      pty,
      channel,
      queue: [],
      ready: false,
    });
  } catch (error) {
    channel.stderr.write(`${error instanceof Error ? error.message : "The compute agent is unavailable"}\n`);
    channel.exit(255);
    channel.end();
    return null;
  }
  channel.on("data", (data) => {
    const stream = streams.get(streamId);
    if (!stream) return;
    if (!stream.ready) {
      const size = stream.queue.reduce((total, item) => total + item.data.length, 0);
      if (size + data.length > 1024 * 1024) return failStream(streamId, "The pending SSH stream exceeded its limit");
      stream.queue.push({ data: Buffer.from(data), channel: 1 });
      return;
    }
    sendData(agent, streamId, data, 1);
  });
  let inputEnded = false;
  const endInput = () => {
    if (inputEnded) return;
    inputEnded = true;
    const stream = streams.get(streamId);
    if (!stream) return;
    stream.inputEnded = true;
    if (stream.ready) json(agent.socket, { type: "end", stream_id: streamId });
  };
  channel.on("eof", endInput);
  channel.on("end", endInput);
  channel.on("close", () => {
    if (!streams.has(streamId)) return;
    json(agent.socket, { type: "close", stream_id: streamId });
    removeStream(streamId);
  });
  return streamId;
}

async function openTcpChannel(authorized, channel, destination) {
  const agent = agents.get(authorized.node_id);
  if (!agent) return channel.close();
  const port = Number(destination?.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return channel.close();
  let streamId;
  try {
    streamId = openStream(agent, {
      kind: "ssh",
      target: "ssh",
      ticket: authorized.ticket,
      mode: "tcp",
      destination: { host: "127.0.0.1", port },
      channel,
      queue: [],
      ready: false,
    });
  } catch {
    channel.close();
    return null;
  }
  channel.on("data", (data) => {
    const stream = streams.get(streamId);
    if (!stream) return;
    if (!stream.ready) {
      const size = stream.queue.reduce((total, item) => total + item.data.length, 0);
      if (size + data.length > 1024 * 1024) return failStream(streamId, "The pending SSH stream exceeded its limit");
      stream.queue.push({ data: Buffer.from(data), channel: 1 });
      return;
    }
    sendData(agent, streamId, data, 1);
  });
  let inputEnded = false;
  const endInput = () => {
    if (inputEnded) return;
    inputEnded = true;
    const stream = streams.get(streamId);
    if (!stream) return;
    stream.inputEnded = true;
    if (stream.ready) json(agent.socket, { type: "end", stream_id: streamId });
  };
  channel.on("eof", endInput);
  channel.on("end", endInput);
  channel.on("close", () => {
    if (!streams.has(streamId)) return;
    json(agent.socket, { type: "close", stream_id: streamId });
    removeStream(streamId);
  });
  return streamId;
}

const sshBridge = createSshBridge({
  secret: sshBridgeSecret,
  open: (authorized, channel, message) => message.mode === "tcp"
    ? openTcpChannel(authorized, channel, message.destination)
    : openSshChannel(authorized, channel, message.mode, message.command, message.pty),
  resize: (streamId, nodeId, cols, rows) => {
    const stream = streams.get(streamId);
    if (stream && stream.agent.nodeId === nodeId)
      json(stream.agent.socket, { type: "resize", stream_id: streamId, cols, rows });
  },
});
sshBridge.server.listen(sshBridgePort, "0.0.0.0", () => console.info(JSON.stringify({ event: "ssh_bridge_started", port: sshBridgePort })));

const server = http.createServer((request, response) => {
  if (request.url === "/health") {
    response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    response.end(JSON.stringify({ status: "ok", connected_agents: agents.size, ssh_streams: sshBridge.clients.size }));
    return;
  }
  const routed = previewGrant(request);
  if (!routed) return response.writeHead(404).end();
  if (routed.error) return sendPreviewStatus(response, routed.error, routed.error === 401 ? {
    eyebrow: "Preview link required",
    title: "Open this preview from Driftverk",
    message: "This address needs a signed preview link.",
    actionHref: publicAppUrl,
    actionLabel: "Open Driftverk",
  } : {
    eyebrow: "Preview link expired",
    title: "This preview link is no longer valid",
    message: "Return to the environment and open a fresh preview.",
    actionHref: publicAppUrl,
    actionLabel: "Open Driftverk",
  });
  const agent = agents.get(routed.nodeId);
  if (!agent) return sendPreviewStatus(response, 503, {
    eyebrow: "Reconnecting",
    title: "The environment is temporarily offline",
    message: "The compute connection is unavailable. Try again in a moment.",
    actionHref: ".",
    actionLabel: "Try again",
    active: true,
  }, { "retry-after": "5" });
  let streamId;
  try {
    streamId = openStream(agent, { kind: "http", target: "preview", method: request.method, path: request.url ?? "/", headers: forwardedHeaders(request.headers), response });
  } catch (error) {
    return sendPreviewStatus(response, 503, {
      eyebrow: "Connection unavailable",
      title: "The preview could not connect",
      message: error instanceof Error ? error.message : "The compute agent is unavailable.",
      actionHref: ".",
      actionLabel: "Try again",
      active: true,
    });
  }
  request.on("data", (chunk) => sendData(agent, streamId, chunk));
  request.on("end", () => json(agent.socket, { type: "end", stream_id: streamId }));
  request.on("aborted", () => { json(agent.socket, { type: "close", stream_id: streamId }); removeStream(streamId); });
  response.on("close", () => {
    if (!streams.has(streamId) || response.writableEnded) return;
    json(agent.socket, { type: "close", stream_id: streamId });
    removeStream(streamId);
  });
});

server.on("upgrade", (request, socket, head) => {
  const url = new URL(request.url ?? "/", "http://gateway");
  if (url.pathname === "/api/tunnel/agent") {
    void authenticateAgent(request).then((nodeId) => {
      if (!nodeId) return socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      agentServer.handleUpgrade(request, socket, head, (websocket) => agentServer.emit("connection", websocket, request, nodeId));
    }).catch(() => socket.end("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n"));
    return;
  }
  const routed = route(request);
  if (!routed || routed.error) return socket.end(`HTTP/1.1 ${routed?.error ?? 404} ${routed?.error === 401 ? "Unauthorized" : "Not Found"}\r\nConnection: close\r\n\r\n`);
  clientServer.handleUpgrade(request, socket, head, (websocket) => clientServer.emit("connection", websocket, request, routed));
});

const heartbeat = setInterval(() => {
  for (const agent of agents.values()) {
    if (!agent.alive) {
      agent.socket.terminate();
      continue;
    }
    agent.alive = false;
    agent.socket.ping();
  }
}, 20_000);
heartbeat.unref();

server.listen(port, "0.0.0.0", () => console.info(JSON.stringify({ event: "data_gateway_started", port, preview_domain: previewDomain })));
