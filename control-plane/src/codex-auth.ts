import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

export type CodexCredentials = { auth_mode: "chatgpt"; tokens: { access_token: string; refresh_token: string; id_token: string; account_id: string }; last_refresh?: string };

export function parseCodexCredentials(raw: string): CodexCredentials {
  const value = JSON.parse(raw);
  if (value.auth_mode !== "chatgpt" || !value.tokens ||
    !["access_token", "refresh_token", "id_token", "account_id"].every(key => typeof value.tokens[key] === "string" && value.tokens[key].length > 0))
    throw new Error("ChatGPT sign-in did not return a usable connection");
  return value;
}

export function needsRefresh(credentials: CodexCredentials, now = Date.now()) {
  try {
    const expires = JSON.parse(Buffer.from(credentials.tokens.access_token.split(".")[1]!, "base64url").toString()).exp;
    return typeof expires !== "number" || expires * 1000 < now + 5 * 60_000;
  } catch { return true; }
}

// Let the official CLI own OAuth and refresh. Each operation has a private HOME,
// no project config, and no access to the control plane's secrets in its env.
export async function openCodexAuth(credentials?: CodexCredentials) {
  const home = await mkdtemp(join(tmpdir(), "driftverk-codex-auth-"));
  try {
    if (credentials) await writeFile(join(home, "auth.json"), JSON.stringify(credentials), { mode: 0o600 });
    await writeFile(join(home, "config.toml"), 'cli_auth_credentials_store = "file"\n', { mode: 0o600 });
    const child = spawn(process.env.CODEX_AUTH_BINARY || "codex", ["app-server", "--stdio"], {
      cwd: home, env: { PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin", HOME: home, CODEX_HOME: home }, stdio: ["pipe", "pipe", "pipe"],
    });
    // Provider diagnostics can contain credentials. Never forward them to logs.
    child.stderr.resume();
    let nextId = 0;
    const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
    let notification: (method: string, params: any) => void = () => {};
    let stopped = false;
    const fail = () => {
      stopped = true;
      for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error("Codex authentication service unavailable")); }
      pending.clear();
    };
    child.on("error", fail); child.on("exit", fail); child.stdin.on("error", fail);
    const lines = createInterface({ input: child.stdout });
    lines.on("line", line => {
      try {
        const message = JSON.parse(line);
        const item = pending.get(message.id);
        if (item) {
          pending.delete(message.id); clearTimeout(item.timer);
          if (message.error) item.reject(new Error("Codex could not complete authentication"));
          else item.resolve(message.result);
        } else if (message.method) notification(message.method, message.params);
      } catch { /* Ignore non-protocol output without logging secrets. */ }
    });
    function request(method: string, params: object = {}, timeoutMs = 15_000): Promise<any> {
      if (stopped) return Promise.reject(new Error("Codex authentication service unavailable"));
      const id = ++nextId;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error("Codex authentication timed out")); }, timeoutMs);
        pending.set(id, { resolve, reject, timer });
        child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
      });
    }
    async function close() {
      fail(); lines.close();
      if (child.exitCode === null) {
        const exited = new Promise<void>(resolve => child.once("exit", () => resolve()));
        child.kill("SIGKILL");
        await Promise.race([exited, new Promise(resolve => { const timer = setTimeout(resolve, 1000); timer.unref(); })]);
      }
      await rm(home, { recursive: true, force: true });
    }
    try {
      await request("initialize", { clientInfo: { name: "driftverk", version: "1.0.0" }, capabilities: {} }, 5_000);
      child.stdin.write('{"method":"initialized"}\n');
    } catch (error) { await close(); throw error; }
    return { request, close, onNotification: (callback: typeof notification) => { notification = callback; },
      credentials: async () => parseCodexCredentials(await readFile(join(home, "auth.json"), "utf8")) };
  } catch (error) { await rm(home, { recursive: true, force: true }); throw error; }
}

export async function refreshCodexCredentials(credentials: CodexCredentials) {
  const session = await openCodexAuth(credentials);
  try {
    const result = await session.request("account/read", { refreshToken: true });
    if (result.account?.type !== "chatgpt") throw new Error("Reconnect ChatGPT in Agents");
    const refreshed = await session.credentials();
    if (refreshed.tokens.account_id !== credentials.tokens.account_id) throw new Error("ChatGPT account changed; reconnect in Agents");
    return refreshed;
  } finally { await session.close(); }
}
