import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import test from "node:test";

const installer = readFileSync(new URL("./agent.sh", import.meta.url), "utf8");
const helper = installer.slice(installer.indexOf("enrollment_domains() {"), installer.indexOf("cleanup() {"));

function domains(response, url) {
  return spawnSync("bash", ["-c", `set -euo pipefail\nfail() { exit 1; }\n${helper}\nenrollment_domains "$1" "$2"\nprintf '%s\\n%s' "$panel_hostname" "$preview_domain"`, "test", JSON.stringify(response), url], { encoding: "utf8" });
}

test("enrollment uses installation domains", () => {
  const result = domains({ panel_hostname: "dev.example.com", preview_domain: "apps.example.net" }, "https://dev.example.com");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "dev.example.com\napps.example.net");
});

test("older servers retain hosted defaults and support custom URLs", () => {
  assert.equal(domains({}, "https://app.driftverk.com").stdout, "app.driftverk.com\npreview.app.driftverk.com");
  assert.equal(domains({}, "https://dev.example.com:8443").stdout, "dev.example.com\npreview.dev.example.com");
});

test("enrollment rejects unsafe dotenv domain values", () => {
  assert.notEqual(domains({ preview_domain: "preview.example.com\nCOMPUTE_AGENT_TOKEN=changed" }, "https://dev.example.com").status, 0);
  assert.notEqual(domains({ panel_hostname: "https://dev.example.com" }, "https://dev.example.com").status, 0);
});
