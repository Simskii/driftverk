import assert from "node:assert/strict";
import { createHash, createHmac, generateKeyPairSync } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import ssh2 from "ssh2";
import { WebSocket, WebSocketServer } from "ws";
import { startDataTunnel } from "../compute-agent/data-tunnel.mjs";
import { decodeDataFrame, encodeDataFrame } from "./protocol.mjs";

const { Client: SshClient } = ssh2;

const previewSecret = "integration-preview-secret-32-characters";
const terminalSecret = "integration-terminal-secret-32-characters";
const sshSecret = "integration-ssh-secret-at-least-32-characters";
const bridgeSecret = "integration-bridge-secret-at-least-32-characters";

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", code => resolve({ code, stdout, stderr }));
  });
}

async function stopProcess(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise(resolve => {
    child.once("close", resolve);
    child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 3000);
    timer.unref();
    child.once("close", () => clearTimeout(timer));
  });
}

async function freePort() {
  const server = http.createServer();
  const port = await listen(server);
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return server.address().port;
}

function signedToken(grant, secret) {
  const payload = Buffer.from(JSON.stringify(grant)).toString("base64url");
  return `${payload}.${createHmac("sha256", secret).update(payload).digest("base64url")}`;
}

async function waitFor(check, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      const result = await check();
      if (result) return result;
    } catch { /* Service may still be starting. */ }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for the tunnel test service");
}

function previewRequest(port, token, cookie) {
  return new Promise((resolve, reject) => {
    const request = http.get({
      hostname: "127.0.0.1",
      port,
      path: `/?token=${encodeURIComponent(token)}`,
      headers: { host: "80-preview-test.preview.dev.example.com", ...(cookie ? { cookie: `dv_preview=${cookie}` } : {}) },
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString() }));
    });
    request.on("error", reject);
  });
}

test("routes preview, terminal, SSH, and SSH forwarding through agent tunnels", async (t) => {
  let sshAuthorizationStatus = 200;
  let sshAuthorizationRequests = 0;
  const controlPlane = http.createServer((request, response) => {
    if (request.url === "/api/gateway/ssh/authorize") {
      sshAuthorizationRequests += 1;
      if (sshAuthorizationStatus !== 200) {
        response.writeHead(sshAuthorizationStatus, { "content-type": "application/json" });
        return response.end(sshAuthorizationStatus === 403 ? '{"error":"SSH access denied"}' : '{"error":"Control plane unavailable"}');
      }
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(request.url === "/api/gateway/ssh/authorize"
      ? '{"sandbox_id":"env-test","node_id":"agent-test","ticket":"ssh-ticket"}'
      : request.headers.authorization === "Bearer other-agent-token" ? '{"node_id":"agent-other"}' : '{"node_id":"agent-test"}');
  });
  const controlPlanePort = await listen(controlPlane);
  t.after(() => controlPlane.close());

  const preview = http.createServer((_request, response) => response.end("preview through tunnel"));
  const previewPort = await listen(preview);
  t.after(() => preview.close());

  const terminalHttp = http.createServer();
  const terminal = new WebSocketServer({ server: terminalHttp });
  terminal.on("connection", (socket) => socket.on("message", (data, binary) => socket.send(data, { binary })));
  const terminalPort = await listen(terminalHttp);
  t.after(() => { terminal.close(); terminalHttp.close(); });

  const reserved = http.createServer();
  const gatewayPort = await listen(reserved);
  await new Promise((resolve) => reserved.close(resolve));
  const reservedSsh = http.createServer();
  const sshPort = await listen(reservedSsh);
  await new Promise((resolve) => reservedSsh.close(resolve));
  const keyDirectory = await mkdtemp(join(tmpdir(), "driftverk-ssh-test-"));
  let gateway;
  let sshGateway;
  t.after(async () => {
    if (sshGateway) await stopProcess(sshGateway);
    if (gateway) await stopProcess(gateway);
    await rm(keyDirectory, { recursive: true, force: true });
  });
  const hostKeyPath = join(keyDirectory, "ssh_host_ed25519_key");
  const keyGeneration = await run("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", hostKeyPath]);
  assert.equal(keyGeneration.code, 0, keyGeneration.stderr);
  const hostPublicKey = (await readFile(`${hostKeyPath}.pub`, "utf8")).trim().split(/\s+/)[1];
  const hostFingerprint = createHash("sha256").update(Buffer.from(hostPublicKey, "base64")).digest("hex");
  const bridgePort = await freePort();
  const healthPort = await freePort();
  const binaryPath = join(keyDirectory, "ssh-gateway");
  const build = await run("go", ["build", "-o", binaryPath, "."], { cwd: new URL("../ssh-gateway/", import.meta.url) });
  assert.equal(build.code, 0, build.stderr);
  gateway = spawn(process.execPath, ["server.mjs"], {
    cwd: new URL(".", import.meta.url),
    env: {
      ...process.env,
      PORT: String(gatewayPort),
      CONTROL_PLANE_URL: `http://127.0.0.1:${controlPlanePort}`,
      PREVIEW_TOKEN_SECRET: previewSecret,
      TERMINAL_TOKEN_SECRET: terminalSecret,
      SSH_TOKEN_SECRET: sshSecret,
      SSH_BRIDGE_PORT: String(bridgePort),
      SSH_BRIDGE_SECRET: bridgeSecret,
      PREVIEW_DOMAIN: "preview.dev.example.com",
      PUBLIC_APP_URL: "https://dev.example.com",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let gatewayErrors = "";
  gateway.stderr.on("data", (chunk) => { gatewayErrors += chunk.toString(); });

  await waitFor(async () => (await fetch(`http://127.0.0.1:${gatewayPort}/health`)).ok);
  sshGateway = spawn(binaryPath, [], {
    env: {
      ...process.env,
      SSH_GATEWAY_PORT: String(sshPort),
      SSH_HOST_KEY_PATH: hostKeyPath,
      CONTROL_PLANE_URL: `http://127.0.0.1:${controlPlanePort}`,
      SSH_TOKEN_SECRET: sshSecret,
      SSH_BRIDGE_URL: `ws://127.0.0.1:${bridgePort}/ssh`,
      SSH_BRIDGE_SECRET: bridgeSecret,
      SSH_HEALTH_ADDR: `127.0.0.1:${healthPort}`,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let sshGatewayLogs = "";
  sshGateway.stderr.on("data", chunk => { sshGatewayLogs += chunk; });
  await waitFor(async () => (await fetch(`http://127.0.0.1:${healthPort}/health`)).ok)
    .catch(error => { throw new Error(`${error.message}: ${sshGatewayLogs}`); });
  for (const [port, headers] of [[bridgePort, {}], [gatewayPort, { authorization: `Bearer ${bridgeSecret}` }]]) {
    const rejected = await new Promise((resolve, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${port}/ssh`, { headers, handshakeTimeout: 2000 });
      socket.once("open", () => { socket.close(); reject(new Error(`SSH bridge unexpectedly exposed on ${port}`)); });
      socket.once("error", resolve);
    });
    assert.ok(rejected, "SSH bridge rejects unauthenticated private requests and authenticated public requests");
  }
  const stopTunnel = startDataTunnel({
    url: `ws://127.0.0.1:${gatewayPort}/api/tunnel/agent`,
    token: "agent-token",
    nodeId: "agent-test",
    targets: {
      preview: { host: "127.0.0.1", port: previewPort },
      terminal: { host: "127.0.0.1", port: terminalPort },
    },
  });
  t.after(stopTunnel);
  await waitFor(async () => (await (await fetch(`http://127.0.0.1:${gatewayPort}/health`)).json()).connected_agents === 1);

  const previewToken = signedToken({ sandboxId: "dev-test", nodeId: "agent-test", port: 80, expiresAt: Date.now() + 60_000 }, previewSecret);
  assert.deepEqual(await previewRequest(gatewayPort, previewToken), { status: 200, body: "preview through tunnel" });
  assert.deepEqual(await previewRequest(gatewayPort, "application-token", previewToken), { status: 200, body: "preview through tunnel" });
  const deniedPreview = await previewRequest(gatewayPort, "application-token");
  assert.equal(deniedPreview.status, 403);
  assert.match(deniedPreview.body, /Driftverk preview/);
  assert.match(deniedPreview.body, /preview link is no longer valid/i);
  assert.match(deniedPreview.body, /href="https:\/\/dev\.example\.com"/);
  const missingPreview = await previewRequest(gatewayPort, "");
  assert.equal(missingPreview.status, 401);
  assert.match(missingPreview.body, /href="https:\/\/dev\.example\.com"/);

  const terminalToken = signedToken({ sandboxId: "dev-test", nodeId: "agent-test", nonce: "test", expiresAt: Date.now() + 60_000 }, terminalSecret);
  const echoed = await new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${gatewayPort}/api/terminal?token=${encodeURIComponent(terminalToken)}`);
    socket.on("open", () => socket.send(Buffer.from("terminal through tunnel")));
    socket.on("message", (data) => { resolve(data.toString()); socket.close(); });
    socket.on("error", reject);
  });
  assert.equal(echoed, "terminal through tunnel");

  const otherPreview = http.createServer((_request, response) => response.end("second host preview"));
  const otherPreviewPort = await listen(otherPreview);
  t.after(() => otherPreview.close());
  const stopOtherTunnel = startDataTunnel({
    url: `ws://127.0.0.1:${gatewayPort}/api/tunnel/agent`,
    token: "other-agent-token", nodeId: "agent-other",
    targets: { preview: { host: "127.0.0.1", port: otherPreviewPort }, terminal: { host: "127.0.0.1", port: terminalPort } },
  });
  t.after(stopOtherTunnel);
  await waitFor(async () => (await (await fetch(`http://127.0.0.1:${gatewayPort}/health`)).json()).connected_agents === 2);
  const otherToken = signedToken({ sandboxId: "dev-other", nodeId: "agent-other", port: 80, expiresAt: Date.now() + 60_000 }, previewSecret);
  assert.deepEqual(await previewRequest(gatewayPort, otherToken), { status: 200, body: "second host preview" });
  assert.deepEqual(await previewRequest(gatewayPort, previewToken), { status: 200, body: "preview through tunnel" });
  stopOtherTunnel();
  await waitFor(async () => (await (await fetch(`http://127.0.0.1:${gatewayPort}/health`)).json()).connected_agents === 1);
  assert.deepEqual(await previewRequest(gatewayPort, previewToken), { status: 200, body: "preview through tunnel" });

  stopTunnel();
  await waitFor(async () => (await (await fetch(`http://127.0.0.1:${gatewayPort}/health`)).json()).connected_agents === 0);
  const fakeAgent = new WebSocket(`ws://127.0.0.1:${gatewayPort}/api/tunnel/agent`, {
    headers: { authorization: "Bearer agent-token", "x-driftverk-node-id": "agent-test" },
  });
  t.after(() => fakeAgent.close());
  await new Promise((resolve, reject) => { fakeAgent.once("open", resolve); fakeAgent.once("error", reject); });
  let openedPty = null;
  let forwardedDestination = null;
  let forwardingId;
  let forwardingReady = false;
  let forwardedInput = "";
  let earlyEof = false;
  let shellStreamId;
  let shellResize;
  fakeAgent.on("message", (raw, binary) => {
    if (binary) {
      const frame = decodeDataFrame(raw);
      if (frame.streamId === forwardingId) forwardedInput += frame.data.toString();
      return;
    }
    const message = JSON.parse(raw.toString());
    if (message.type === "resize" && message.stream_id === shellStreamId) {
      shellResize = { rows: message.rows, cols: message.cols };
      fakeAgent.send(encodeDataFrame(shellStreamId, Buffer.from("resized shell\n"), 1));
      fakeAgent.send(JSON.stringify({ type: "exit", stream_id: shellStreamId, code: 7 }));
      return;
    }
    if (message.type === "end" && message.stream_id === forwardingId) {
      earlyEof = !forwardingReady;
      fakeAgent.send(encodeDataFrame(forwardingId, Buffer.from(forwardedInput), 1));
      fakeAgent.send(JSON.stringify({ type: "end", stream_id: forwardingId }));
      return;
    }
    if (message.type !== "open" || message.kind !== "ssh") return;
    if (message.mode === "shell") {
      shellStreamId = message.stream_id;
      fakeAgent.send(JSON.stringify({ type: "ready", stream_id: shellStreamId }));
      return;
    }
    if (message.mode === "tcp") {
      forwardedDestination = message.destination;
      forwardingId = message.stream_id;
      setTimeout(() => {
        forwardingReady = true;
        fakeAgent.send(JSON.stringify({ type: "ready", stream_id: forwardingId }));
      }, 150);
      return;
    }
    openedPty = message.pty;
    fakeAgent.send(JSON.stringify({ type: "ready", stream_id: message.stream_id }));
    fakeAgent.send(encodeDataFrame(message.stream_id, Buffer.from("ssh through tunnel\n"), 1));
    fakeAgent.send(encodeDataFrame(message.stream_id, Buffer.from("warning\n"), 2));
    fakeAgent.send(JSON.stringify({ type: "exit", stream_id: message.stream_id, code: 0 }));
  });
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const sshResult = await new Promise((resolve, reject) => {
    const client = new SshClient();
    client.on("ready", () => {
      client.exec("echo test", { pty: { term: "xterm-256color", rows: 41, cols: 123 } }, (error, channel) => {
        if (error) return reject(error);
        let stdout = "";
        let stderr = "";
        let exitCode = null;
        channel.on("data", (chunk) => { stdout += chunk; });
        channel.stderr.on("data", (chunk) => { stderr += chunk; });
        channel.on("exit", (code) => { exitCode = code; });
        channel.on("close", () => { client.end(); resolve({ stdout, stderr, exitCode }); });
      });
    });
    client.on("error", reject);
    client.connect({
      host: "127.0.0.1",
      port: sshPort,
      username: "acme.test",
      privateKey: privateKey.export({ type: "pkcs1", format: "pem" }),
      hostHash: "sha256",
      hostVerifier: fingerprint => fingerprint === hostFingerprint,
      readyTimeout: 5000,
    });
  });
  assert.deepEqual(sshResult, { stdout: "ssh through tunnel\n", stderr: "warning\n", exitCode: 0 });
  assert.deepEqual(openedPty, { term: "xterm-256color", rows: 41, cols: 123 });
  const shellResult = await new Promise((resolve, reject) => {
    const client = new SshClient();
    client.once("error", reject);
    client.on("ready", () => client.shell({ term: "xterm", rows: 24, cols: 80 }, (error, channel) => {
      if (error) { client.end(); reject(error); return; }
      let stdout = "";
      let exitCode;
      channel.on("data", chunk => { stdout += chunk; });
      channel.on("exit", code => { exitCode = code; });
      channel.on("close", () => { client.end(); resolve({ stdout, exitCode }); });
      channel.setWindow(42, 132, 0, 0);
    }));
    client.connect({ host: "127.0.0.1", port: sshPort, username: "acme.test", privateKey: privateKey.export({ type: "pkcs1", format: "pem" }), readyTimeout: 5000 });
  });
  assert.deepEqual(shellResize, { rows: 42, cols: 132 });
  assert.deepEqual(shellResult, { stdout: "resized shell\n", exitCode: 7 });
  const persistentClient = new SshClient();
  t.after(() => persistentClient.end());
  await new Promise((resolve, reject) => {
    persistentClient.once("ready", resolve).once("error", reject).connect({ host: "127.0.0.1", port: sshPort, username: "acme.test", privateKey: privateKey.export({ type: "pkcs1", format: "pem" }) });
  });
  const abandonedShell = await new Promise((resolve, reject) => persistentClient.shell((error, channel) => error ? reject(error) : resolve(channel)));
  await waitFor(async () => (await (await fetch(`http://127.0.0.1:${gatewayPort}/health`)).json()).ssh_streams === 1);
  abandonedShell.close();
  await waitFor(async () => (await (await fetch(`http://127.0.0.1:${gatewayPort}/health`)).json()).ssh_streams === 0);
  assert.equal((await (await fetch(`http://127.0.0.1:${healthPort}/health`)).json()).ssh_clients, 1, "closing a channel releases its bridge without closing SSH connection");
  persistentClient.end();
  const forwarded = await new Promise((resolve, reject) => {
    const client = new SshClient();
    client.on("ready", () => {
      client.forwardOut("127.0.0.1", 54321, "127.0.0.1", 8080, (error, channel) => {
        if (error) return reject(error);
        const chunks = [];
        channel.on("data", (chunk) => chunks.push(chunk));
        channel.on("close", () => { client.end(); resolve(Buffer.concat(chunks).toString()); });
        channel.end("forward-through-tunnel");
      });
    });
    client.on("error", reject);
    client.connect({
      host: "127.0.0.1",
      port: sshPort,
      username: "acme.test",
      privateKey: privateKey.export({ type: "pkcs1", format: "pem" }),
      readyTimeout: 5000,
    });
  });
  assert.equal(forwarded, "forward-through-tunnel");
  assert.equal(earlyEof, false);
  assert.deepEqual(forwardedDestination, { host: "127.0.0.1", port: 8080 });
  const deniedForward = await new Promise((resolve, reject) => {
    const client = new SshClient();
    client.on("ready", () => client.forwardOut("127.0.0.1", 54321, "example.com", 443, error => {
      client.end();
      resolve(error);
    }));
    client.once("error", reject);
    client.connect({ host: "127.0.0.1", port: sshPort, username: "acme.test", privateKey: privateKey.export({ type: "pkcs1", format: "pem" }) });
  });
  assert.ok(deniedForward, "forwarding to a non-loopback destination is denied");
  assert.deepEqual(forwardedDestination, { host: "127.0.0.1", port: 8080 }, "denied forwarding never reaches the agent");

  const clientKeyPath = join(keyDirectory, "client_key");
  await writeFile(clientKeyPath, privateKey.export({ type: "pkcs1", format: "pem" }), { mode: 0o600 });
  const supportedKex = await run("ssh", ["-Q", "kex"]);
  assert.equal(supportedKex.code, 0, supportedKex.stderr);
  await t.test("OpenSSH negotiates hybrid ML-KEM without a warning", {
    skip: supportedKex.stdout.split(/\r?\n/).includes("mlkem768x25519-sha256") ? false : "Installed OpenSSH does not support ML-KEM; Go client integration must verify PQ",
  }, async () => {
    const pqResult = await run("ssh", [
      "-vv", "-F", "/dev/null", "-o", "BatchMode=yes", "-o", "IdentitiesOnly=yes",
      "-o", "StrictHostKeyChecking=no", "-o", "UserKnownHostsFile=/dev/null",
      "-o", "ConnectTimeout=5", "-o", "KexAlgorithms=mlkem768x25519-sha256",
      "-i", clientKeyPath, "-p", String(sshPort), "acme.test@127.0.0.1", "echo test",
    ]);
    assert.equal(pqResult.code, 0, pqResult.stderr);
    assert.equal(pqResult.stdout, "ssh through tunnel\n");
    assert.match(pqResult.stderr, /kex: algorithm: mlkem768x25519-sha256/);
    assert.doesNotMatch(pqResult.stderr, /not using a post-quantum/);
  });

  sshAuthorizationStatus = 403;
  const deniedAuthentication = await new Promise(resolve => {
    const client = new SshClient();
    client.once("ready", () => { client.end(); resolve(null); });
    client.once("error", error => { client.end(); resolve(error); });
    client.connect({ host: "127.0.0.1", port: sshPort, username: "acme.test", privateKey: privateKey.export({ type: "pkcs1", format: "pem" }), readyTimeout: 5000 });
  });
  assert.ok(deniedAuthentication, "control-plane denial rejects authentication");
  sshAuthorizationStatus = 200;
  const idleClient = new SshClient();
  await new Promise((resolve, reject) => {
    idleClient.once("ready", resolve).once("error", reject).connect({ host: "127.0.0.1", port: sshPort, username: "acme.test", privateKey: privateKey.export({ type: "pkcs1", format: "pem" }) });
  });
  let idleClosed = false;
  const disconnected = new Promise(resolve => idleClient.once("close", () => { idleClosed = true; resolve(); }));
  let requestsBeforeChange = sshAuthorizationRequests;
  sshAuthorizationStatus = 503;
  await waitFor(() => sshAuthorizationRequests > requestsBeforeChange, 5000);
  assert.equal(idleClosed, false, "temporary control-plane failure preserves an authenticated SSH connection");
  requestsBeforeChange = sshAuthorizationRequests;
  sshAuthorizationStatus = 200;
  await waitFor(() => sshAuthorizationRequests > requestsBeforeChange, 5000);
  assert.equal(idleClosed, false, "SSH connection remains open after authorization recovers");
  sshAuthorizationStatus = 403;
  await Promise.race([disconnected, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error("Disabled SSH left an existing connection open")), 9000); timer.unref(); })]);
  fakeAgent.close();
  await waitFor(async () => (await (await fetch(`http://127.0.0.1:${gatewayPort}/health`)).json()).connected_agents === 0).catch(error => { throw new Error(`${error.message}: ${gatewayErrors}`); });
  sshAuthorizationStatus = 200;
  const offlineResult = await run("ssh", [
    "-F", "/dev/null", "-o", "BatchMode=yes", "-o", "IdentitiesOnly=yes",
    "-o", "StrictHostKeyChecking=no", "-o", "UserKnownHostsFile=/dev/null", "-o", "ConnectTimeout=5",
    "-i", clientKeyPath, "-p", String(sshPort), "acme.test@127.0.0.1", "echo test",
  ]);
  assert.equal(offlineResult.code, 255, "offline compute agent fails the SSH command");
  assert.equal(offlineResult.stdout, "");
  const restoredTunnel = startDataTunnel({ url: `ws://127.0.0.1:${gatewayPort}/api/tunnel/agent`, token: "agent-token", nodeId: "agent-test", targets: { preview: { host: "127.0.0.1", port: previewPort }, terminal: { host: "127.0.0.1", port: terminalPort } } });
  t.after(restoredTunnel);
  await waitFor(async () => (await (await fetch(`http://127.0.0.1:${gatewayPort}/health`)).json()).connected_agents === 1);
  assert.equal((await previewRequest(gatewayPort, previewToken)).status, 200, "SSH revocation leaves preview access intact");
  const terminalAfterDisable = await new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${gatewayPort}/api/terminal?token=${encodeURIComponent(terminalToken)}`);
    socket.on("open", () => socket.send("terminal after SSH disabled"));
    socket.on("message", data => { resolve(data.toString()); socket.close(); });
    socket.on("error", reject);
  });
  assert.equal(terminalAfterDisable, "terminal after SSH disabled");
  assert.equal(gatewayErrors, "");
});
