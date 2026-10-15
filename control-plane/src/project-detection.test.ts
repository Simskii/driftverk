import assert from "node:assert/strict";
import test from "node:test";
import { suggestProjectSetup } from "./project-detection.js";

test("suggests locked npm install and dev script without guessing an app port", () => {
  const result = suggestProjectSetup(["package.json", "package-lock.json"], { scripts: { dev: "vite", start: "node server" } });
  assert.equal(result.setup_command, "npm ci");
  assert.equal(result.startup_command, "npm run dev");
  assert.equal(result.readiness_command, "");
});
test("handles unsupported repositories and does not interpolate repository scripts", () => {
  assert.equal(suggestProjectSetup(["go.mod"], null).setup_command, "");
  assert.equal(suggestProjectSetup(["package.json", "pnpm-lock.yaml"], { scripts: { dev: "$(malicious)" } }).startup_command, "corepack pnpm run dev");
  assert.equal(suggestProjectSetup(["package.json", "yarn.lock"], { scripts: { start: "app" } }).setup_command, "corepack yarn install");
  assert.equal(suggestProjectSetup(["package.json"], { scripts: { dev: false } }).startup_command, "");
});
test("prefers a standard root Compose file and starts the complete project", () => {
  const result = suggestProjectSetup(["package.json", "compose.yaml"], { scripts: { dev: "vite" } });
  assert.equal(result.setup_command, "");
  assert.equal(result.compose_file, "compose.yaml");
  assert.equal(result.startup_command, "");
  assert.equal(result.readiness_command, "");
  assert.match(result.notes[0]!, /Detected compose\.yaml/);
});
test("uses the standard Compose filename precedence", () => {
  const result = suggestProjectSetup(["docker-compose.yml", "compose.yml"], null);
  assert.match(result.notes[0]!, /Detected compose\.yml/);
});
