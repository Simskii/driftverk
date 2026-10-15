import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { tailscaleScript, tailscaleCommand, parseTailscaleOutput } from "./tailscale-command.js";

test("Tailscale setup is bounded and accepts only a real Tailscale authorization URL", () => {
  const login = parseTailscaleOutput('noise\n{"state":"needs_login","auth_url":"https://login.tailscale.com/a/abc123"}\n{"partial":');
  assert.equal(login?.auth_url, "https://login.tailscale.com/a/abc123");
  for (const url of ["javascript:alert(1)", "https://login.tailscale.com.evil.test/a/abc", "https://evil.test", "https://login.tailscale.com@evil.test/a/abc"]) {
    assert.equal(parseTailscaleOutput(JSON.stringify({ state: "needs_login", auth_url: url }))?.auth_url, undefined);
  }
  assert.equal(parseTailscaleOutput('{"state":"connected","hostname":"env.tail.ts.net","ips":["100.64.0.1", {}, "$(bad)"]}')?.ips.length, 1);
  for (const action of ["status", "connect", "logout"] as const) assert.ok(tailscaleCommand(action).length <= 8000);
  const syntax = spawnSync("python3", ["-c", "import sys; compile(sys.stdin.read(), '<tailscale>', 'exec')"], { input: tailscaleScript });
  assert.equal(syntax.status, 0, syntax.stderr.toString());
});
