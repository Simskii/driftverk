import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { WebSocket, WebSocketServer } from 'ws';
import { bufferTerminalInput } from './persistent-terminal.mjs';

test('terminal preserves input sent immediately after WebSocket opens', async t => {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  t.after(() => server.close());
  await once(server, 'listening');
  const connected = once(server, 'connection');
  const client = new WebSocket(`ws://127.0.0.1:${server.address().port}`);
  t.after(() => client.terminate());
  client.on('open', () => client.send(Buffer.from('printf early\\n')));
  const [socket] = await connected;
  t.after(() => socket.terminate());
  const activate = bufferTerminalInput(socket);
  // Hold shell startup until the client's first frame has arrived.
  await once(socket, 'message');
  const received = [];
  assert.equal(activate((data, binary) => received.push([data.toString(), binary])), true);
  assert.deepEqual(received, [['printf early\\n', true]]);
  client.send(JSON.stringify({ type: 'resize', cols: 80, rows: 24 }));
  await once(socket, 'message');
  assert.deepEqual(received[1], ['{"type":"resize","cols":80,"rows":24}', false]);
});

for (const limit of ['bytes', 'frames']) {
  test(`terminal limits queued ${limit} during shell startup`, () => {
    const socket = new EventEmitter();
    let code;
    socket.close = value => { code = value; };
    const activate = bufferTerminalInput(socket);
    if (limit === 'bytes') socket.emit('message', Buffer.alloc(65_537), true);
    else for (let i = 0; i < 1025; i++) socket.emit('message', Buffer.alloc(0), true);
    assert.equal(code, 1009);
    assert.equal(activate(() => assert.fail('Closed input must not be replayed')), false);
  });
}

test('terminal discards pending input when client disconnects during startup', () => {
  const socket = new EventEmitter();
  const activate = bufferTerminalInput(socket);
  socket.emit('message', Buffer.from('command'), true);
  socket.emit('close');
  assert.equal(activate(() => assert.fail('Disconnected input must not be replayed')), false);
});
