import test from 'node:test';
import assert from 'node:assert/strict';
import { websocketActivity } from './websocket-activity.mjs';

test('ignores ping/pong and close, counts text, binary and continuation payloads', () => {
  let calls = 0;
  const observe = websocketActivity(() => calls++);
  observe(Buffer.from([0x89, 1, 42, 0x8a, 1, 42, 0x88, 0]));
  assert.equal(calls, 0);
  observe(Buffer.from([0x81, 1, 42, 0x82, 1, 42, 0x80, 1, 42]));
  assert.equal(calls, 3);
});
test('handles split masked headers, extended lengths, compressed frames and control frames between fragments', () => {
  let calls = 0;
  const observe = websocketActivity(() => calls++);
  const header = Buffer.from([0xc2, 0xfe, 0, 126, 1, 2, 3, 4]);
  for (const byte of header) observe(Buffer.from([byte]));
  assert.equal(calls, 0);
  observe(Buffer.alloc(100));
  observe(Buffer.concat([Buffer.alloc(26), Buffer.from([0x89, 0])]));
  assert.equal(calls, 2);
  const large = Buffer.alloc(14);
  large[0] = 0x82; large[1] = 0xff; large.writeBigUInt64BE(65536n, 2);
  observe(large);
  observe(Buffer.alloc(65536));
  observe(Buffer.from([0x8a, 0]));
  assert.equal(calls, 3);
});

test('observing a real proxy preserves messages and excludes protocol keepalives', async () => {
  const { default: http } = await import('node:http');
  const { once } = await import('node:events');
  const { default: httpProxy } = await import('http-proxy');
  const { WebSocket, WebSocketServer } = await import('ws');
  const upstream = new WebSocketServer({port:0,host:'127.0.0.1'});
  await once(upstream,'listening');
  upstream.on('connection', socket => socket.on('message', data => socket.send(data)));
  const proxy = httpProxy.createProxyServer({ws:true});
  const server = http.createServer();
  let calls = 0;
  server.on('upgrade',(request,socket,head) => {
    socket.pause();
    socket.on('data',websocketActivity(() => calls++));
    proxy.ws(request,socket,head,{target:`http://127.0.0.1:${upstream.address().port}`});
  });
  server.listen(0,'127.0.0.1');
  await once(server,'listening');
  const client = new WebSocket(`ws://127.0.0.1:${server.address().port}`);
  try {
    await once(client,'open');
    let pong = once(client,'pong'); client.ping('keepalive'); await pong;
    assert.equal(calls,0);
    const response = once(client,'message'); client.send('still forwarded');
    assert.equal((await response)[0].toString(),'still forwarded');
    assert.ok(calls > 0);
    const previous = calls;
    pong = once(client,'pong'); client.ping('keepalive'); await pong;
    assert.equal(calls,previous);
  } finally {
    client.terminate();
    for (const socket of upstream.clients) socket.terminate();
    await Promise.all([new Promise(resolve => server.close(resolve)),new Promise(resolve => upstream.close(resolve))]);
    proxy.close();
  }
});
