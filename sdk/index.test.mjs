import assert from "node:assert/strict";
import test from "node:test";
import { Driftverk, DriftverkError } from "./index.mjs";
const make = fetch => new Driftverk({ baseUrl: "https://example.test", apiKey: "local-test", fetch });
const output = sequence => `id: ${sequence}\nevent: output\ndata: ${JSON.stringify({ sequence, stream: "stdout", byte_offset: 0, data: "aGk=" })}\n\n`;

test("transport retry reuses explicit mutation key and body", async () => {
  const calls = [];
  const client = make(async (url, init) => {
    calls.push({url,init});
    if (calls.length === 1) throw new TypeError("Connection lost after accepting command");
    return Response.json({ data: { id: "exec_1" } });
  });
  assert.equal((await client.execute("dev_1", { command: "true" }, { idempotencyKey: "stable-run-1" })).id, "exec_1");
  assert.equal(calls.length, 2);
  assert.equal(calls[0].init.headers["Idempotency-Key"], "stable-run-1");
  assert.equal(calls[1].init.headers["Idempotency-Key"], "stable-run-1");
  assert.equal(calls[0].init.body, calls[1].init.body);
});

test("SSE reconnect preserves cursor and drops replay, including split frames", async () => {
  const cursors = []; let count = 0;
  const client = make(async (_url, init) => {
    cursors.push(init.headers["Last-Event-ID"]);
    if (++count === 1) return new Response(output("1") + 'event: output\ndata: {"sequence":');
    const data = output("1") + output("2") + 'event: done\ndata: {"status":"succeeded","exit_code":0}\n\n';
    return new Response(new ReadableStream({ start(controller) {
      const bytes = new TextEncoder().encode(data);
      for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.slice(i, i + 7));
      controller.close();
    } }));
  });
  const events = [];
  for await (const event of client.events("exec_1")) events.push(event);
  assert.deepEqual(cursors, ["0", "1"]);
  assert.deepEqual(events.map(event => event.type === "output" ? event.sequence : event.type), ["1", "2", "done"]);
  assert.equal(Buffer.from(events[0].bytes).toString(), "hi");
});

test("authorization failures stop reconnection and expose HTTP status", async () => {
  let calls = 0;
  const client = make(async () => { calls++; return Response.json({ error: { message: "Forbidden" } }, { status: 403 }); });
  await assert.rejects(async () => { for await (const _ of client.events("exec_1")) {} }, error => error instanceof DriftverkError && error.status === 403);
  assert.equal(calls, 1);
});

test("aborting observation does not cancel the remote command", async () => {
  const abort = new AbortController(); abort.abort(); let calls = 0;
  const client = make(async () => { calls++; return Response.json({}); });
  await assert.rejects(async () => { for await (const _ of client.events("exec_1", { signal: abort.signal })) {} });
  assert.equal(calls, 0);
});

test("setup and lifecycle methods preserve inputs, encode IDs and apply mutation keys", async () => {
  const calls = [];
  const client = make(async (url, init) => { calls.push({ url, ...init }); return Response.json({ data: { ok: true } }); });
  const input = { name: "project", configuration: { image: "driftverk-dev:1", auto_stop_minutes: null } };
  const signal = new AbortController().signal;
  await client.createProjectSetup(input, { idempotencyKey: "setup-create-1", signal });
  await client.updateProjectSetup("id/1", input, { idempotencyKey: "setup-update-1" });
  await client.getProjectSetup("id/1");
  await client.deleteProjectSetup("id/1");
  await client.listEnvironments();
  await client.listSnapshots();
  await client.startEnvironment("id/1");
  await client.stopEnvironment("id/1");
  await client.createPreview("id/1", 3000, { signal });
  assert.deepEqual(calls.map(call => [call.method, call.url.replace("https://example.test/v1", "")]), [
    ["POST", "/project-setups"], ["PUT", "/project-setups/id%2F1"], ["GET", "/project-setups/id%2F1"],
    ["DELETE", "/project-setups/id%2F1"], ["GET", "/environments"], ["GET", "/snapshots"],
    ["POST", "/environments/id%2F1/start"], ["POST", "/environments/id%2F1/stop"], ["POST", "/environments/id%2F1/ports/3000/preview"],
  ]);
  assert.deepEqual(JSON.parse(calls[0].body), input);
  assert.deepEqual(JSON.parse(calls[1].body), input);
  assert.equal(calls[0].signal, signal);
  assert.equal(calls[8].signal, signal);
  assert.equal(calls[0].headers["Idempotency-Key"], "setup-create-1");
  assert.equal(calls[1].headers["Idempotency-Key"], "setup-update-1");
  for (const index of [3, 6, 7]) assert.match(calls[index].headers["Idempotency-Key"], /^[a-f0-9-]{36}$/);
  assert.equal(calls[8].headers["Idempotency-Key"], undefined, "preview grants are not retried as idempotent mutations");
});

test("prebuild waits read the requested build directly and report failures", async () => {
  const urls = [];
  const client = make(async url => {
    urls.push(url);
    return Response.json({ data: { id: "old-build", status: urls.length === 1 ? "building" : "ready" } });
  });
  assert.equal((await client.waitForPrebuild("old-build")).status, "ready");
  assert.deepEqual(urls, Array(2).fill("https://example.test/v1/prebuilds/old-build"));
  const failed = make(async () => Response.json({ data: { status: "failed", error_message: "Install failed" } }));
  await assert.rejects(failed.waitForPrebuild("build"), /Install failed/);
  await assert.rejects(client.waitForPrebuild("build", { signal: AbortSignal.abort() }));
});
