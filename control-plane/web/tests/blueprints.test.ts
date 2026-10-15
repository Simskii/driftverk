import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("blueprints have a navigable management view", async () => {
  const app = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");
  const fields = await readFile(new URL("../src/DevelopmentFields.tsx", import.meta.url), "utf8");

  assert.match(app, /<NavItem to="\/blueprints" icon={<Blueprint \/>} label="Blueprints" \/>/);
  assert.match(app, /<Route path="\/blueprints" element={<ProjectSetupsPage \/>} \/>/);
  assert.match(app, /<Route path="\/project-setups" element={<Navigate to="\/blueprints" replace \/>} \/>/);
  assert.match(fields, /Delete blueprint\?/);
  assert.match(fields, /method: "DELETE"/);
  assert.match(fields, /Existing environments are not affected\./);
  assert.match(fields, /className="data-table blueprint-table"/);
  assert.match(fields, /organization_secret_names\?\.length \? "Configured" : "None"/);
  assert.doesNotMatch(fields, /organization_secret_names\?\.join/);
  assert.doesNotMatch(fields, /latest\.error_message/);
  assert.match(fields, /type="checkbox" role="switch" aria-label="Keep a preview ready"/);
  assert.doesNotMatch(fields, /Check setup and rebuild\./);
  assert.doesNotMatch(fields, /Prepared and stopped until needed\./);
  assert.doesNotMatch(fields, /Ready and stopped/);
  assert.doesNotMatch(fields, /Use a prepared snapshot blueprint with startup and readiness commands to enable this\./);
});
