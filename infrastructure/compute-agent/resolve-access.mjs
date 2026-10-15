import net from "node:net";

export class AccessError extends Error {
  constructor(message, status = 503) { super(message); this.status = status; }
}

// Validate legacy preview links before treating a generic ?token as ours.
// A failed application token must not hide an authorized preview cookie.
export async function resolvePreviewAccess(url, agentToken, body, { queryToken, cookieToken }, options = {}) {
  try {
    const result = await resolveAccess(url, agentToken, { ...body, token: queryToken || cookieToken || "" }, options);
    return { result, queryToken: queryToken || null };
  } catch (error) {
    if (!queryToken || !cookieToken || ![401, 403].includes(error.status)) throw error;
    const result = await resolveAccess(url, agentToken, { ...body, token: cookieToken }, options);
    return { result, queryToken: null };
  }
}

// A 202 is a pending wake, never an authorized runtime target.
export async function resolveAccess(url, agentToken, body, {
  deadline = Date.now() + 45_000,
  fetcher = fetch,
  wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  while (Date.now() < deadline) {
    const response = await fetcher(url, {
      method: "POST",
      headers: { authorization: `Bearer ${agentToken}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(Math.max(1, Math.min(5000, deadline - Date.now()))),
    });
    const result = await response.json().catch(() => ({}));
    if (response.ok && response.status !== 202 && /^[a-f0-9]{12,64}$/i.test(result.runtime_id ?? "")) return result;
    if (response.status !== 202 || result.status !== "starting")
      throw new AccessError(result.error ?? "Environment access failed", response.ok ? 502 : response.status);
    await wait(Math.min(500, Math.max(0, deadline - Date.now())));
  }
  throw new AccessError("Environment startup timed out. Check its lifecycle logs and try again.");
}

export async function waitForPort(host, port, deadline) {
  while (Date.now() < deadline) {
    const ready = await new Promise((resolve) => {
      const socket = net.createConnection({ host, port });
      const finish = (value) => { socket.destroy(); resolve(value); };
      socket.once("connect", () => finish(true));
      socket.once("error", () => finish(false));
      socket.setTimeout(Math.max(1, Math.min(1000, deadline - Date.now())), () => finish(false));
    });
    if (ready) return;
    await new Promise((resolve) => setTimeout(resolve, Math.min(250, Math.max(0, deadline - Date.now()))));
  }
  throw new AccessError("The environment started, but this port is not listening. Check the app startup command and bind it to 0.0.0.0.");
}

export function activityReporter(controlPlaneUrl, token, nodeId, sandboxId) {
  let lastReportedAt = 0;
  return () => {
    if (Date.now() - lastReportedAt < 15_000) return;
    lastReportedAt = Date.now();
    void fetch(`${controlPlaneUrl}/api/compute/activity`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ node_id: nodeId, sandbox_id: sandboxId }),
      signal: AbortSignal.timeout(5000),
    }).catch(() => undefined);
  };
}
