import { prepareAgentConnection } from './agent-connection.mjs';
import http from "node:http";
import { agentTerminalCommand } from './agent-terminal.mjs';
import { bufferTerminalInput, terminalCommand } from './persistent-terminal.mjs';
import { AccessError, resolveAccess, activityReporter } from "./resolve-access.mjs";
import Docker from "dockerode";
import { WebSocketServer, WebSocket } from "ws";

const controlPlaneUrl = required("CONTROL_PLANE_URL").replace(/\/$/, "");
const agentToken = required("COMPUTE_AGENT_TOKEN");
const nodeId = process.env.COMPUTE_NODE_ID || "compute-1";
const port = Number(process.env.WEB_TERMINAL_PORT || 2223);
const docker = new Docker({ socketPath: "/var/run/docker.sock" });
const sockets = new WebSocketServer({ noServer: true, maxPayload: 65_536 });

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function resolve(token) {
  return resolveAccess(`${controlPlaneUrl}/api/compute/terminal/resolve`, agentToken, { node_id: nodeId, token, agent_sessions: true, agent_protection: true, agent_credentials: true });
}

const server = http.createServer((request, response) => {
  if (request.url === "/health") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end('{"status":"ok"}');
    return;
  }
  response.writeHead(404).end();
});

server.on("upgrade", async (request, socket, head) => {
  try {
    const url = new URL(request.url || "/", "http://localhost");
    if (url.pathname !== "/api/terminal") throw new Error("Unknown terminal endpoint");
    const token = url.searchParams.get("token") || "";
    const target = await resolve(token);
    sockets.handleUpgrade(request, socket, head, (websocket) => sockets.emit("connection", websocket, request, target));
  } catch (error) {
    const status = error instanceof AccessError ? error.status : 503;
    socket.write(`HTTP/1.1 ${status} Connection failed\r\nConnection: close\r\n\r\n`);
    socket.destroy();
  }
});

sockets.on("connection", async (websocket, _request, target) => {
  let stream;
  let idleTimer;
  const activateInput = bufferTerminalInput(websocket);
  websocket.on("close", () => { clearTimeout(idleTimer); stream?.destroy(); });
  try {
    if (!/^[a-f0-9]{12,64}$/.test(target.runtime_id)) throw new Error("Invalid runtime target");
    const activity = activityReporter(controlPlaneUrl, agentToken, nodeId, target.sandbox_id);
    const container = docker.getContainer(target.runtime_id);
    const details = await container.inspect();
    if (!details.State?.Running || details.Config?.Labels?.["driftverk.server-id"] !== target.sandbox_id)
      throw new Error("Runtime target mismatch");
    if (target.agent_connection) await prepareAgentConnection(container, target.agent_connection);
    const exec = await container.exec({
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
      Tty: true,
      Cmd: target.agent ? agentTerminalCommand({ ...target.agent, account_id: target.agent_connection?.account_id }) : terminalCommand('web'),
      Env: ["TERM=xterm-256color", ...Object.entries(target.environment ?? {}).map(([name, value]) => `${name}=${value}`), ...(target.agent_connection ? [`DRIFTVERK_CHATGPT_ACCOUNT_ID=${target.agent_connection.account_id}`] : [])],
    });
    stream = await exec.start({ hijack: true, stdin: true, Tty: true });
    if (websocket.readyState !== WebSocket.OPEN) { stream.destroy(); return; }
    const refreshIdle = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => websocket.close(1000, "Terminal session timed out"), 30 * 60 * 1000);
    };
    refreshIdle();
    stream.on("data", (chunk) => { activity(); if (websocket.readyState === WebSocket.OPEN) websocket.send(chunk, { binary: true }); });
    stream.on("end", () => websocket.close(1000, "Shell exited"));
    stream.on("error", () => websocket.close(1011, "Terminal stream failed"));
    activateInput(async (data, isBinary) => {
      refreshIdle();
      if (isBinary) { activity(); return stream.write(data); }
      try {
        const message = JSON.parse(data.toString());
        if (message.type === "resize" && Number.isInteger(message.cols) && Number.isInteger(message.rows))
          await exec.resize({ w: Math.min(500, Math.max(20, message.cols)), h: Math.min(200, Math.max(5, message.rows)) });
      } catch { /* Ignore malformed control frames. */ }
    });
  } catch (error) {
    if (websocket.readyState === WebSocket.OPEN) websocket.close(1011, error instanceof Error ? error.message.slice(0, 120) : "Terminal failed");
  }
});

server.listen(port, "0.0.0.0", () => console.log(JSON.stringify({ event: "web_terminal_ready", port, node_id: nodeId })));
