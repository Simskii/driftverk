import assert from "node:assert/strict";
import test from "node:test";
import net from "node:net";
import { AccessError, resolveAccess, resolvePreviewAccess, waitForPort } from "./resolve-access.mjs";

test("preview, terminal and SSH wait through 202 until a runtime is ready", async () => {
  for (const path of ["preview", "terminal", "ssh"]) {
    let calls = 0;
    let waits = 0;
    const result = await resolveAccess(`http://localhost/${path}`, "agent", {}, {
      fetcher: async () => ++calls < 3
        ? Response.json({ status: "starting" }, { status: 202 })
        : Response.json({ runtime_id: "abcdef123456", sandbox_id: "env" }),
      wait: async () => { waits++; },
    });
    assert.equal(result.runtime_id, "abcdef123456");
    assert.equal(calls, 3);
    assert.equal(waits, 2);
  }
});

test("access rejects denied or malformed targets without retrying", async () => {
  for (const status of [200, 403, 404, 409]) {
    let calls = 0;
    await assert.rejects(resolveAccess("http://localhost", "agent", {}, {
      fetcher: async () => { calls++; return Response.json({ error: "unavailable" }, { status }); },
    }), (error) => error instanceof AccessError && error.status === (status === 200 ? 502 : status));
    assert.equal(calls, 1);
  }
});

test("startup deadline returns a service error instead of an authorization error", async () => {
  await assert.rejects(resolveAccess("http://localhost", "agent", {}, { deadline: Date.now() - 1 }),
    (error) => error instanceof AccessError && error.status === 503);
});

test("preview waits for app readiness and bounds an unavailable port", async () => {
  const server = net.createServer(socket => socket.end());
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await waitForPort("127.0.0.1", port, Date.now() + 1000);
  await new Promise(resolve => server.close(resolve));
  const waiting = waitForPort("127.0.0.1", port, Date.now() + 1500);
  const timer = setTimeout(() => server.listen(port, "127.0.0.1"), 100);
  try { await waiting; } finally { clearTimeout(timer); await new Promise(resolve => server.close(resolve)); }
  await assert.rejects(waitForPort("127.0.0.1", port, Date.now() + 50), /not listening/);
});


test("preview authorization preserves application tokens and renews preview grants", async () => {
  for (const queryToken of ["app-session", "header.payload.signature"]) {
    const calls = [];
    const authorized = await resolvePreviewAccess("http://control/preview", "agent", { port: 8080 },
      { queryToken, cookieToken: "valid-cookie" }, {
        fetcher: async (_url, init) => {
          const body = JSON.parse(init.body); calls.push(body.token);
          return body.token === "valid-cookie"
            ? Response.json({ runtime_id: "abcdef123456", sandbox_id: "env" })
            : Response.json({ error: "Invalid preview token" }, { status: 403 });
        },
      });
    assert.deepEqual(calls, [queryToken, "valid-cookie"]);
    assert.equal(authorized.queryToken, null, "HTTP and WebSocket forwarding must retain the app query");
  }
  let calls = 0;
  const authorized = await resolvePreviewAccess("http://control/preview", "agent", {},
    { queryToken: "fresh-grant", cookieToken: "expired-cookie" }, {
      fetcher: async () => { calls++; return Response.json({ runtime_id: "abcdef123456" }); },
    });
  assert.equal(calls, 1);
  assert.equal(authorized.queryToken, "fresh-grant", "only an authorized query grant is consumed");
});

test("preview fallback never masks runtime failures or authorizes invalid credentials", async () => {
  for (const status of [401, 403, 503]) {
    let calls = 0;
    await assert.rejects(resolvePreviewAccess("http://control/preview", "agent", {},
      { queryToken: "invalid", cookieToken: "also-invalid" }, {
        fetcher: async () => { calls++; return Response.json({ error: "Denied" }, { status }); },
      }), error => error.status === status);
    assert.equal(calls, status === 503 ? 1 : 2);
  }
});
