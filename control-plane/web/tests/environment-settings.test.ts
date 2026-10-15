import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("environment settings use switches and explain independent access paths", async () => {
  const app = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");
  const access = await readFile(new URL("../src/EnvironmentAccess.tsx", import.meta.url), "utf8");
  const controls = await readFile(new URL("../src/EnvironmentControls.tsx", import.meta.url), "utf8");
  const settings = app.slice(app.indexOf('{tab === "settings" &&'), app.indexOf('<OverviewSection title="Environment variables">'));
  for (const input of [...settings.matchAll(/<input[^>]+type="checkbox"[^>]*>/g), ...access.matchAll(/<input[^>]+type="checkbox"[^>]*>/g)]) {
    assert.match(input[0], /role="switch"/);
  }
  assert.match(access, /Connect through Driftverk’s SSH gateway\./);
  assert.match(access, /SSH access follows your tailnet’s access rules/);
  assert.match(settings, /disabled={!environment.preview_enabled \|\| previewBusy/);
  assert.match(settings, /disabled={lifecycleBusy \|\| !environment.can_manage_lifecycle}/);
  assert.match(controls, /type="checkbox" role="switch" checked={replace}/);
  assert.match(controls, /<input disabled={disabled} aria-label={`\$\{label\} amount`}/);
  assert.match(controls, /<select disabled={disabled} aria-label={`\$\{label\} unit`}/);
});

test("Tailscale distinguishes permissions, active operations, and stopped environments", async () => {
  const access = await readFile(new URL("../src/EnvironmentAccess.tsx", import.meta.url), "utf8");
  assert.match(access, /!environment.can_manage_lifecycle \? "An organization admin/);
  assert.match(access, /!canConfigure \? "Tailscale setup requires a trusted environment/);
  assert.match(access, /environment.active_operation \? "Wait for the current environment operation/);
  assert.match(access, /environment.state !== "running" \? "Start the environment/);
  assert.match(access, /!\["connected", "not_installed", "needs_login", "needs_approval"\].includes\(status.state\)/);
});
