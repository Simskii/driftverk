#!/usr/bin/env node
// A dependency-free example of an agent using the browser you are watching.
// The CDP endpoint is available only inside the environment.
const targets = await (await fetch('http://127.0.0.1:9222/json/list')).json();
const target = targets.find(target => target.type === 'page' && target.url.endsWith('/welcome.html'));
if (!target) throw new Error('Open the prototype welcome tab before running this demo. Other tabs are left alone.');
const socket = new WebSocket(target.webSocketDebuggerUrl);
const pending = new Map();
let sequence = 0;
socket.addEventListener('message', event => {
  const message = JSON.parse(event.data);
  const call = pending.get(message.id);
  if (!call) return;
  pending.delete(message.id);
  clearTimeout(call.timer);
  if (message.error) call.reject(new Error(message.error.message));
  else call.resolve(message.result);
});
socket.addEventListener('close', () => {
  for (const call of pending.values()) {
    clearTimeout(call.timer);
    call.reject(new Error('Browser disconnected'));
  }
  pending.clear();
});
await new Promise((resolve, reject) => {
  const timer = setTimeout(() => { socket.close(); reject(new Error('CDP connection timed out')); }, 5000);
  socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
  socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('Could not connect to Chromium')); }, { once: true });
});
function call(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out`)); }, 5000);
    pending.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ id, method, params }));
  });
}
try {
  await call('Page.bringToFront');
  await call('Runtime.evaluate', { expression: 'document.querySelector("#note").focus()' });
  await call('Input.insertText', { text: 'Hello from the agent. We share this browser.' });
  for (let i = 0; i < 10; i++) {
    const result = await call('Runtime.evaluate', { expression: 'document.querySelector("#counter").click(); document.querySelector("#counter").textContent', returnByValue: true });
    console.log(result.result.value);
    await new Promise(resolve => setTimeout(resolve, 800));
  }
} finally {
  socket.close();
}
