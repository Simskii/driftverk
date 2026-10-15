import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { renderAgentInstaller } from "./agent-installer.js";

test("downloaded installer enrolls with its own installation and keeps explicit overrides", () => {
  const script = readFileSync(new URL("../installer/agent.sh", import.meta.url), "utf8");
  for (const url of ["https://dev.example.test/", "https://dev.example.test/'$(printf injected)"]) {
    const rendered = renderAgentInstaller(script, url);
    assert.equal(spawnSync("bash", ["-n"], { input: rendered }).status, 0);
    const assignments = rendered.slice(0, rendered.indexOf("INSTALL_DIR=")).split("\n").filter(line => /^(DEFAULT_CONTROL_PLANE_URL|CONTROL_PLANE_URL)=/.test(line)).join("\n");
    const result = spawnSync("bash", ["-c", assignments + '\nprintf "%s" "$CONTROL_PLANE_URL"'], { env: { PATH: process.env.PATH }, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, url.replace(/\/$/, ""));
    const overridden = spawnSync("bash", ["-c", assignments + '\nprintf "%s" "$CONTROL_PLANE_URL"'], { env: { PATH: process.env.PATH, DRIFTVERK_CONTROL_PLANE_URL: "https://override.example.test" }, encoding: "utf8" });
    assert.equal(overridden.stdout, "https://override.example.test");
  }
});
