import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { createServer } from "vite";
import type { Billing } from "../src/Billing.tsx";

const server = await createServer({ configFile: "vite.config.ts", optimizeDeps: { noDiscovery: true, include: [] }, server: { middlewareMode: true, hmr: false, ws: false }, appType: "custom" });
after(() => server.close());
const { CloudUsage } = await server.ssrLoadModule("/src/Billing.tsx");
const data = {
  currency: "usd", complimentary: false, hourly_ore: "7",
  daily_usage: [{ day: "2026-09-07", amount_ore: "1800" }],
  resources: [
    { id: "env-one", name: "one", environment_name: "one", resource_type: "environment", compute_hour_ore: "6.6", storage_hour_ore: "0.2" },
    { id: "env-two", name: "two", environment_name: "two", resource_type: "environment", compute_hour_ore: "50", storage_hour_ore: "1" },
  ],
} as Billing;
const render = (billing: Billing, environmentId?: string) => renderToStaticMarkup(createElement(MemoryRouter, null, createElement(CloudUsage, { data: billing, environmentId })));

test("environment billing shows only its current rate, not organization spending", () => {
  const html = render(data, "env-one");
  assert.match(html, /\$0\.0680/);
  assert.match(html, /\$0\.0660/);
  assert.match(html, /\$0\.0020/);
  assert.doesNotMatch(html, /\$18\.00|\$0\.5000|Total spend/);
  assert.match(html, /Before shared storage allowance/);
  assert.match(html, /<details class="billing-disclosure">/);
  assert.doesNotMatch(html, /<details[^>]* open/);
});

test("stopped and unmetered environments do not invent compute charges", () => {
  const stopped = render({ ...data, resources: [{ ...data.resources[0]!, compute_hour_ore: "0" }] }, "env-one");
  assert.match(stopped, /\$0\.0020/);
  assert.match(stopped, /\$0\.0000/);
  const empty = render(data, "missing");
  assert.match(empty, /No metered resources yet/);
  assert.match(empty, /\$0\.0000/);
});

test("complimentary environment billing does not display a billable rate", () => {
  const html = render({ ...data, complimentary: true }, "env-one");
  assert.match(html, /Complimentary access\. No charges apply/);
  assert.doesNotMatch(html, /\$0\.0680/);
});

test("organization usage preserves totals and collapses resource detail", () => {
  const html = render(data);
  assert.match(html, /\$18\.00/);
  assert.match(html, /Resource breakdown/);
  assert.match(html, /aria-label="Daily Cloud charges/);
  assert.doesNotMatch(html, /<details[^>]* open/);
  assert.match(render({ ...data, daily_usage: [] }), /No usage charges yet/);
});
