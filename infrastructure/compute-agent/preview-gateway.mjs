import { websocketActivity } from "./websocket-activity.mjs";
import http from "node:http";
import { AccessError, resolvePreviewAccess, waitForPort, activityReporter } from "./resolve-access.mjs";
import httpProxy from "http-proxy";
import Docker from "dockerode";
import { previewStatusPage } from "./preview-status-page.mjs";

const docker = new Docker({ socketPath: "/var/run/docker.sock" });

const controlPlaneUrl = process.env.CONTROL_PLANE_URL?.replace(/\/$/, "");
const token = process.env.COMPUTE_AGENT_TOKEN;
const nodeId = process.env.COMPUTE_NODE_ID;
const port = Number(process.env.PREVIEW_GATEWAY_PORT ?? 8081);
const previewDomain = process.env.PREVIEW_DOMAIN ?? "preview.app.driftverk.com";

function sendPreviewStatus(response, status, options) {
  response.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
    "referrer-policy": "no-referrer",
  });
  response.end(previewStatusPage(options));
}

if (!controlPlaneUrl || !token || !nodeId || !Number.isInteger(port)) {
  console.error("CONTROL_PLANE_URL, COMPUTE_AGENT_TOKEN, COMPUTE_NODE_ID and PREVIEW_GATEWAY_PORT are required");
  process.exit(1);
}

const proxy = httpProxy.createProxyServer({ ws: true, xfwd: true, changeOrigin: false });
proxy.on("error", (error, _request, response) => {
  if (response && "writeHead" in response && !response.headersSent) sendPreviewStatus(response, 502, {
    eyebrow: "App unavailable",
    title: "The preview target did not respond",
    message: "Check that the app is running and listening on the selected port.",
    actionHref: ".",
    actionLabel: "Try again",
    active: true,
  });
  else if (response && "end" in response) response.end("Preview target is unavailable");
  console.error(JSON.stringify({ event: "preview_proxy_error", message: error.message }));
});

function previewRequest(request) {
  const host = String(request.headers.host ?? "").split(":")[0].toLowerCase();
  const suffix = `.${previewDomain}`;
  if (!host.endsWith(suffix)) return null;
  const prefix = host.slice(0, -suffix.length);
  const match = prefix.match(/^(\d{1,5})-([a-z0-9-]+)$/);
  if (!match) return null;
  const requestedPort = Number(match[1]);
  if (requestedPort < 1 || requestedPort > 65535) return null;
  const queryToken = new URL(request.url ?? "/", "http://preview").searchParams.get("token");
  const cookieToken = String(request.headers.cookie ?? "").split(";").map((part) => part.trim()).find((part) => part.startsWith("dv_preview="))?.slice(11);
  return { port: requestedPort, previewId: match[2], token: queryToken || cookieToken || "", queryToken, cookieToken };
}

async function resolveTarget(input) {
  const deadline = Date.now() + 45_000;
  const authorized = await resolvePreviewAccess(`${controlPlaneUrl}/api/compute/preview/resolve`, token,
    { node_id: nodeId, preview_id: input.previewId, port: input.port }, input, { deadline });
  const { result } = authorized;
  input.queryToken = authorized.queryToken;
  const container = await docker.getContainer(result.runtime_id).inspect();
  if (!container?.State?.Running || container.Config?.Labels?.["driftverk.server-id"] !== result.sandbox_id)
    throw new AccessError("Preview runtime target mismatch", 403);
  const address = container.NetworkSettings?.Networks?.[process.env.SANDBOX_NETWORK || "bridge"]?.IPAddress;
  if (!address) throw new AccessError("Preview container has no reachable IP address");
  await waitForPort(address, input.port, deadline);
  return { url: `http://${address}:${input.port}`, sandboxId: result.sandbox_id };
}

async function handle(request, response) {
  if (request.url === '/health') { response.writeHead(200); response.end('ok'); return; }
  const input = previewRequest(request);
  if (!input?.token) {
    return sendPreviewStatus(response, 401, {
      eyebrow: "Preview link required",
      title: "Open this preview from Driftverk",
      message: "This address needs a signed preview link.",
      actionHref: controlPlaneUrl,
      actionLabel: "Open Driftverk",
    });
  }
  try {
    const target = await resolveTarget(input);
    if (input.queryToken) {
      const cleanUrl = new URL(request.url ?? "/", "https://preview");
      cleanUrl.searchParams.delete("token");
      response.writeHead(302, {
        location: `${cleanUrl.pathname}${cleanUrl.search}`,
        "set-cookie": `dv_preview=${input.queryToken}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=3600`,
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
      });
      return response.end();
    }
    response.setHeader("referrer-policy", "no-referrer");
    proxy.web(request, response, { target: target.url });
  } catch (error) {
    sendPreviewStatus(response, error instanceof AccessError ? error.status : 503, {
      eyebrow: error instanceof AccessError && error.status === 403 ? "Preview unavailable" : "Reconnecting",
      title: error instanceof AccessError && error.status === 403 ? "This preview cannot be opened" : "The environment is still getting ready",
      message: error instanceof AccessError ? error.message : "The preview is temporarily unavailable. Try again.",
      actionHref: ".",
      actionLabel: "Try again",
      active: !(error instanceof AccessError) || error.status >= 500,
    });
    console.error(JSON.stringify({ event: "preview_access_denied", message: error instanceof Error ? error.message : "Unknown error" }));
  }
}

const server = http.createServer((request, response) => void handle(request, response));
server.on("upgrade", (request, socket, head) => {
  const input = previewRequest(request);
  if (!input?.token) return socket.destroy();
  void resolveTarget(input).then((target) => {
    if (input.queryToken) {
      const cleanUrl = new URL(request.url ?? "/", "https://preview");
      cleanUrl.searchParams.delete("token");
      request.url = `${cleanUrl.pathname}${cleanUrl.search}`;
    }
    const observe = websocketActivity(activityReporter(controlPlaneUrl, token, nodeId, target.sandboxId));
    // http-proxy unshifts head and resumes the socket when its upstream pipe is ready.
    // Keep it paused until then so observing activity cannot consume data before forwarding.
    socket.pause();
    socket.on("data", observe);
    proxy.ws(request, socket, head, { target: target.url });
  }).catch(() => socket.destroy());
});
server.listen(port, "0.0.0.0", () => console.log(JSON.stringify({ event: "preview_gateway_started", node_id: nodeId, port, domain: previewDomain })));

export { previewRequest };
