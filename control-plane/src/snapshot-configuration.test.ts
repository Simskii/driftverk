import assert from "node:assert/strict";
import test from "node:test";
import { parseDevelopmentConfig, parsePreviewPort } from "./development-config.js";

process.env.DATABASE_URL ??= "postgres://test:test@localhost:5432/test";
process.env.BETTER_AUTH_URL ??= "http://localhost:3000";
process.env.BETTER_AUTH_SECRET ??= "test-better-auth-secret-000000000";
process.env.SECRET_ENCRYPTION_KEYS ??= "test=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
process.env.PREVIEW_TOKEN_SECRET ??= "test-preview-secret-0000000000000";
process.env.TERMINAL_TOKEN_SECRET ??= "test-terminal-secret-000000000000";
process.env.SSH_TOKEN_SECRET ??= "test-ssh-secret-000000000000000000";
process.env.COMPUTE_AGENT_TOKEN ??= "test-compute-secret-0000000000000";
const { snapshotLaunchConfiguration, resolveSnapshotConfiguration } = await import("./snapshot-configuration.js");

const environment = {
  cpu_count: 4, memory_mb: 8192, workspace_path: "/workspaces/app",
  startup_command: "npm run dev", readiness_command: "curl -f localhost:5173",
  preview_enabled: true, preview_port: 5173,
  repository: "owner/app", setup_command: "npm ci", initialization_command: "npm run seed",
  environment_variables: [{ name: "SECRET", value: "private" }], volume_mounts: [{ volume_id: "private" }],
};

test("snapshot launch defaults retain the app directory without copying clone, seed, secrets or mounts", () => {
  assert.deepEqual(snapshotLaunchConfiguration(environment), {
    cpu: 4, memory_mb: 8192, workspace_path: "/workspaces/app",
    startup_command: "npm run dev", readiness_command: "curl -f localhost:5173",
    preview_enabled: true, preview_port: 5173,
  });
});

test("snapshot restore uses captured defaults and honors explicit overrides", async () => {
  const client = { query: async (sql: string, values: unknown[]) => {
    assert.match(sql, /organization_id=\$2 AND status='ready'/);
    assert.deepEqual(values, ["snapshot", "org"]);
    return { rows: [{ launch_configuration: snapshotLaunchConfiguration(environment) }] };
  } } as unknown as Parameters<typeof resolveSnapshotConfiguration>[2];
  const restored = await resolveSnapshotConfiguration("org", { source_type: "snapshot", snapshot_id: "snapshot", startup_command: "", preview_port: null, cpu: 2 }, client);
  assert.equal(restored.workspace_path, "/workspaces/app");
  assert.equal(restored.startup_command, "");
  assert.equal(restored.preview_port, null);
  assert.equal(restored.cpu, 2);
  const development = parseDevelopmentConfig(restored);
  assert.equal(development.workspace_path, "/workspaces/app");
  assert.equal(development.repository, null);
  assert.equal(development.setup_command, null);
  assert.equal(development.initialization_command, null);
});

test("legacy snapshots retain their previous behavior and prepared repository flows keep their own configuration", async () => {
  const client = { query: async () => ({ rows: [{ launch_configuration: null }] }) } as unknown as Parameters<typeof resolveSnapshotConfiguration>[2];
  const input = { source_type: "snapshot", snapshot_id: "legacy" };
  assert.deepEqual(await resolveSnapshotConfiguration("org", input, client), input);
  const noQuery = { query: async () => { throw new Error("Must not load snapshot defaults"); } } as unknown as Parameters<typeof resolveSnapshotConfiguration>[2];
  for (const extra of [{ repository: "owner/app" }, { prebuild_id: "prebuild" }]) {
    assert.deepEqual(await resolveSnapshotConfiguration("org", { ...input, ...extra }, noQuery), { ...input, ...extra });
  }
});

test("preview ports and restored working directories reject invalid values", () => {
  for (const value of [0, 65536, -1, 1.5, true, [], "1e3", "bad"]) assert.throws(() => parsePreviewPort(value));
  assert.equal(parsePreviewPort("5173"), 5173);
  assert.equal(parsePreviewPort(null), null);
  assert.equal(parsePreviewPort(65535), 65535);
  for (const path of ["/etc", "/workspace/../etc", "/workspaces/app/.", "relative", "/workspace/a;echo"]) assert.throws(() => parseDevelopmentConfig({ workspace_path: path }));
  assert.equal(parseDevelopmentConfig({ repository: "owner/app" }).workspace_path, "/workspaces/app");
});
