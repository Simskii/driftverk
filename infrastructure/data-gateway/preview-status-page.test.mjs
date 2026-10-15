import assert from "node:assert/strict";
import test from "node:test";
import { previewStatusPage } from "./preview-status-page.mjs";

test("renders a responsive animated preview status page and escapes dynamic content", () => {
  const html = previewStatusPage({
    eyebrow: "Reconnecting",
    title: "Waiting <now>",
    message: 'App said "try again" & stopped.',
    actionHref: ".",
    actionLabel: "Try again",
    active: true,
  });

  assert.match(html, /<!doctype html>/);
  assert.match(html, /Driftverk preview/);
  assert.match(html, /class="shell active"/);
  assert.match(html, /prefers-reduced-motion:reduce/);
  assert.match(html, /Waiting &lt;now&gt;/);
  assert.match(html, /App said &quot;try again&quot; &amp; stopped\./);
  assert.doesNotMatch(html, /Waiting <now>/);
});
