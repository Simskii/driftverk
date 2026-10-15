import { setTimeout as delay } from "node:timers/promises";

const terminal = new Set(["succeeded", "failed", "cancelled", "timed_out", "output_limit", "lost"]);
const segment = encodeURIComponent;
export class DriftverkError extends Error {
  constructor(message, status, idempotencyKey) {
    super(message); this.name = "DriftverkError"; this.status = status; this.idempotencyKey = idempotencyKey;
  }
}

/** Server-side client. Never expose workspace API keys to a browser. */
export class Driftverk {
  constructor({ baseUrl, apiKey, fetch: fetcher = globalThis.fetch }) {
    if (!apiKey || !baseUrl) throw new Error("baseUrl and apiKey are required");
    this.baseUrl = baseUrl.replace(/\/$/, ""); this.apiKey = apiKey; this.fetch = fetcher;
  }
  async request(path, { method = "GET", body, idempotencyKey, signal, raw = false, headers = {} } = {}) {
    let response;
    // Reuse the same key across transport retries. Persist a caller-supplied key across process restarts.
    for (let attempt = 0; ; attempt++) {
      try {
        response = await this.fetch(`${this.baseUrl}/v1${path}`, {
          method, signal, redirect: "error",
          headers: { Authorization: `Bearer ${this.apiKey}`, ...headers,
            ...(body === undefined ? {} : { "Content-Type": "application/json" }),
            ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}) },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        break;
      } catch (error) {
        if (signal?.aborted || attempt >= 2 || (method !== "GET" && !idempotencyKey)) {
          if (idempotencyKey) error.idempotencyKey = idempotencyKey;
          throw error;
        }
        await delay(250 * 2 ** attempt, undefined, { signal });
      }
    }
    if (!response.ok) {
      const payload = await response.json().catch(() => null);
      throw new DriftverkError(payload?.error?.message || payload?.error || `Request failed (${response.status})`, response.status, idempotencyKey);
    }
    return raw ? response : (await response.json()).data;
  }
  listProjectSetups(options) { return this.request("/project-setups", options); }
  getProjectSetup(id, options) { return this.request(`/project-setups/${segment(id)}`, options); }
  createProjectSetup(input, options = {}) { return this.request("/project-setups", { ...options, method: "POST", body: input, idempotencyKey: options.idempotencyKey ?? crypto.randomUUID() }); }
  updateProjectSetup(id, input, options = {}) { return this.request(`/project-setups/${segment(id)}`, { ...options, method: "PUT", body: input, idempotencyKey: options.idempotencyKey ?? crypto.randomUUID() }); }
  deleteProjectSetup(id, options = {}) { return this.request(`/project-setups/${segment(id)}`, { ...options, method: "DELETE", idempotencyKey: options.idempotencyKey ?? crypto.randomUUID() }); }
  listPrebuilds(options) { return this.request("/prebuilds", options); }
  getPrebuild(id, options) { return this.request(`/prebuilds/${segment(id)}`, options); }
  buildPrebuild(input, options = {}) { return this.request("/prebuilds", { ...options, method: "POST", body: input, idempotencyKey: options.idempotencyKey ?? crypto.randomUUID() }); }
  createEnvironment(input, options = {}) { return this.request("/environments", { ...options, method: "POST", body: input, idempotencyKey: options.idempotencyKey ?? crypto.randomUUID() }); }
  listEnvironments(options) { return this.request("/environments", options); }
  listSnapshots(options) { return this.request("/snapshots", options); }
  getEnvironment(id, options) { return this.request(`/environments/${segment(id)}`, options); }
  startEnvironment(id, options = {}) { return this.request(`/environments/${segment(id)}/start`, { ...options, method: "POST", idempotencyKey: options.idempotencyKey ?? crypto.randomUUID() }); }
  stopEnvironment(id, options = {}) { return this.request(`/environments/${segment(id)}/stop`, { ...options, method: "POST", idempotencyKey: options.idempotencyKey ?? crypto.randomUUID() }); }
  createPreview(id, port, options = {}) { return this.request(`/environments/${segment(id)}/ports/${segment(port)}/preview`, { ...options, method: "POST" }); }
  getOperation(id, options) { return this.request(`/operations/${segment(id)}`, options); }
  deleteEnvironment(id, options = {}) { return this.request(`/environments/${segment(id)}`, { ...options, method: "DELETE", idempotencyKey: options.idempotencyKey ?? crypto.randomUUID() }); }
  execute(environmentId, input, options = {}) { return this.request(`/environments/${segment(environmentId)}/executions`, { ...options, method: "POST", body: input, idempotencyKey: options.idempotencyKey ?? crypto.randomUUID() }); }
  getExecution(id, options) { return this.request(`/executions/${segment(id)}`, options); }
  readOutput(id, { after = "0", ...options } = {}) { return this.request(`/executions/${segment(id)}/output?after=${segment(after)}`, options); }
  cancelExecution(id, options = {}) { return this.request(`/executions/${segment(id)}/cancel`, { ...options, method: "POST" }); }
  deleteExecution(id, options = {}) { return this.request(`/executions/${segment(id)}`, { ...options, method: "DELETE" }); }
  async artifact(id, path, options = {}) { return new Uint8Array(await (await this.request(`/executions/${segment(id)}/artifact?path=${segment(path)}`, { ...options, raw: true })).arrayBuffer()); }
  async waitFor(read, ready, { timeoutMs = 600000, signal } = {}) {
    const bounded = AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])]);
    while (true) {
      bounded.throwIfAborted(); const value = await read({ signal: bounded });
      if (ready(value)) return value;
      await delay(500, undefined, { signal: bounded });
    }
  }
  waitForOperation(id, options) {
    return this.waitFor(opts => this.getOperation(id, opts), value => {
      if (value.status === "failed") throw new Error(value.error_message || "Environment operation failed");
      return value.status === "succeeded";
    }, options);
  }
  waitForPrebuild(id, options) {
    return this.waitFor(opts => this.getPrebuild(id, opts), value => {
      if (value.status === "failed") throw new Error(value.error_message || "Prebuild failed");
      return value.status === "ready";
    }, options);
  }
  waitForExecution(id, options) { return this.waitFor(opts => this.getExecution(id, opts), value => terminal.has(value.status), options); }

  /** Reconnects SSE using the last delivered output sequence. Abort stops listening, not the command. */
  async *events(id, { after = "0", signal, timeoutMs = 3600000 } = {}) {
    let cursor = String(after), failures = 0;
    const bounded = AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])]);
    while (true) {
      bounded.throwIfAborted();
      let reader;
      try {
        const response = await this.request(`/executions/${segment(id)}/events`, {
          raw: true, signal: bounded, headers: { Accept: "text/event-stream", "Last-Event-ID": cursor },
        });
        if (!response.body) throw new Error("Missing event stream");
        reader = response.body.getReader();
        const decoder = new TextDecoder(); let pending = "";
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          pending += decoder.decode(chunk.value, { stream: true });
          let boundary;
          while ((boundary = pending.indexOf("\n\n")) !== -1) {
            const lines = pending.slice(0, boundary).split("\n"); pending = pending.slice(boundary + 2);
            let type = "message", data = "";
            for (const line of lines) {
              if (line.startsWith("event:")) type = line.slice(6).trim();
              if (line.startsWith("data:")) data += line.slice(5).trimStart() + "\n";
            }
            if (!data) continue;
            const value = JSON.parse(data); failures = 0;
            if (type === "output" && BigInt(value.sequence) > BigInt(cursor)) {
              cursor = value.sequence;
              yield { type: "output", ...value, bytes: new Uint8Array(Buffer.from(value.data, "base64")) };
            } else if (type === "done") { yield { type: "done", execution: value }; return; }
          }
        }
      } catch (error) {
        if (bounded.aborted || (error instanceof DriftverkError && error.status < 500 && error.status !== 429) || ++failures > 5) throw error;
      } finally { await reader?.cancel().catch(() => {}); }
      await delay(Math.min(250 * 2 ** failures, 5000), undefined, { signal: bounded });
    }
  }
}
