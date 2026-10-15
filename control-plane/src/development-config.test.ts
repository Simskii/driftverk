import assert from "node:assert/strict";
import test from "node:test";
import { parseDevelopmentConfig, parseTemplate } from "./development-config.js";

test("normalizes GitHub repositories and rejects URL credentials and unsafe branches", () => {
  assert.deepEqual(parseDevelopmentConfig({ repository: "https://github.com/acme/app.git", repository_branch: "feature/dev" }), {
    repository: "acme/app", repository_branch: "feature/dev", setup_command: null, initialization_command: null, startup_command: null, readiness_command: null, workspace_path: "/workspaces/app",
  });
  for (const repository of ["https://user:token@github.com/acme/app", "https://evil.test/acme/app", "acme/..", "-evil/app", "acme/app;id"]) assert.throws(() => parseDevelopmentConfig({ repository }));
  for (const repository_branch of ["--upload-pack=evil", "a..b", "a b", "a.lock", "a/.hidden", "a@{b", "a\\b"]) assert.throws(() => parseDevelopmentConfig({ repository: "acme/app", repository_branch }));
});

test("templates retain explicit settings and drop credentials, variables and runtime state", () => {
  const value = parseTemplate({ name: "Project", configuration: { source_type: "image", image: "driftverk-dev:1", cpu: 4, memory_mb: 8192, auto_stop_minutes: null, repository: "acme/app", setup_command: "npm ci", token: "secret", environment_variables: [{ name: "KEY", value: "secret" }], runtime_id: "container" } });
  assert.equal(value.configuration.auto_stop_minutes, null);
  assert.equal(parseTemplate({ name: "Small", configuration: { image: "nginx", cpu: 1, memory_mb: 1024 } }).configuration.memory_mb, 1024);
  assert.equal(value.configuration.setup_command, "npm ci");
  assert.equal(JSON.stringify(value).includes('"secret"'), false);
  assert.throws(() => parseTemplate({ name: "Project", configuration: { image: "node", cpu: 100 } }));
  assert.equal(parseTemplate({ name: "Snapshot", configuration: { source_type: "snapshot", snapshot_id: "snap_1", image: "ignored" } }).configuration.image, null);
});

test("startup and readiness are validated and retained in reusable setups", () => {
  const config = parseDevelopmentConfig({ startup_command: " npm run dev ", readiness_command: "curl -f localhost:3000" });
  assert.equal(config.workspace_path, "/workspace");
  assert.equal(config.startup_command, "npm run dev");
  assert.equal(parseTemplate({ name: "App", configuration: { image: "driftverk-dev:1", ...config } }).configuration.readiness_command, "curl -f localhost:3000");
  assert.throws(() => parseDevelopmentConfig({ startup_command: "a\0b" }));
  assert.throws(() => parseDevelopmentConfig({ readiness_command: "x".repeat(8001) }));
});
