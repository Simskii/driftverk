// Runs only on the disposable Ubuntu Actions VM. Never point it at an operator's host.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile, appendFile } from 'node:fs/promises';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import https from 'node:https';
import { createRequire } from 'node:module';
// Reuse the gateway's declared WebSocket dependency for transport QA.
const WebSocket = createRequire(new URL('../../infrastructure/data-gateway/package.json', import.meta.url))('ws');

assert.equal(process.env.GITHUB_ACTIONS, 'true', 'This test requires a disposable GitHub Actions runner');
const exec = promisify(execFile);
const root = '/tmp/driftverk-oss-qa';
const host = '127.0.0.1';
const base = 'http://localhost:8080';
const compose = ['compose', '--env-file', `${root}/env`, '-f', 'compose.yaml', '-f', `${root}/compose.yaml`];
const computeCompose = ['compose', '--env-file', '/opt/driftverk-oss-qa/.env.compute', '-f', '/opt/driftverk-oss-qa/compose.compute.yaml'];
const secret = () => randomBytes(32).toString('base64');
const record = async message => { console.log(message); await appendFile(`${root}/results.txt`, `- ${message}\n`); };
const command = (file, args, options = {}) => exec(file, args, { timeout: 120_000, maxBuffer: 8 * 1024 * 1024, ...options });

if (process.argv[2] === 'prepare') {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const settings = { NODE_ENV: 'development', INSTALLATION_MODE: 'self-hosted', POSTGRES_PASSWORD: randomBytes(32).toString('hex'),
    BETTER_AUTH_URL: base, TRUSTED_ORIGINS: base, BETTER_AUTH_SECRET: secret(), SECRET_ENCRYPTION_KEYS: `qa=${secret()}`,
    PREVIEW_TOKEN_SECRET: secret(), TERMINAL_TOKEN_SECRET: secret(), SSH_TOKEN_SECRET: secret(), SSH_BRIDGE_SECRET: secret(),
    COMPUTE_AGENT_TOKEN: secret(), AUTH_ALLOW_SIGN_UP: 'true', AUTH_REQUIRE_EMAIL_VERIFICATION: 'true', EMAIL_MODE: 'console',
    PREVIEW_DOMAIN: 'preview.localhost', SSH_PUBLIC_HOST: host, HTTP_PORT: '8080', HTTPS_PORT: '443', APP_DOMAIN: 'http://localhost' };
  await writeFile(`${root}/env`, Object.entries(settings).map(([k,v]) => `${k}=${v}`).join('\n')+'\n', { mode: 0o600 });
  await writeFile(`${root}/Caddyfile`, `http://localhost, http://qa-panel {\n handle /api/tunnel/* {\n reverse_proxy data-gateway:3001\n }\n handle /api/terminal* {\n reverse_proxy data-gateway:3001\n }\n handle {\n reverse_proxy control-plane:3000\n }\n}\nhttps://*.preview.localhost {\n tls internal\n reverse_proxy data-gateway:3001\n}\n`);
  await writeFile(`${root}/compose.yaml`, `services:\n  caddy:\n    volumes:\n      - ${root}/Caddyfile:/etc/caddy/Caddyfile:ro\n`);
  process.exit(0);
}

const cookieJar = new Map();
async function request(path, body, method = body === undefined ? 'GET' : 'POST') {
  const response = await fetch(base + path, { method, headers: { Origin: base, Cookie: [...cookieJar].map(([k,v]) => `${k}=${v}`).join('; '), 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30_000) });
  const cookies = response.headers.getSetCookie();
  for (const value of cookies) { const pair = value.split(';')[0]; const separator = pair.indexOf('='); cookieJar.set(pair.slice(0, separator), pair.slice(separator + 1)); }
  const value = await response.json();
  assert.ok(response.ok, `${method} ${path}: ${response.status} ${JSON.stringify(value)}`);
  return value;
}
async function until(label, operation, seconds = 180) {
  const deadline = Date.now() + seconds * 1000;
  while (Date.now() < deadline) {
    const result = await operation();
    if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  throw new Error(`Timed out: ${label}`);
}
function healthSummary(health) {
  const services = new Set(['docker', 'sysbox', 'sysbox-fs', 'sysbox-mgr', 'preview-gateway', 'web-terminal', 'compute-agent', 'data-tunnel', 'host-watchdog']);
  return (health?.checks ?? []).filter(c => services.has(c.service) && ['healthy', 'unhealthy', 'recovering'].includes(c.status))
    .map(c => `${c.service}=${c.status}`).join(', ') || 'no report';
}
async function hostDiagnostics() {
  // Print only known health fields and numeric HTTP status, never raw logs,
  // environment variables, enrollment output, response bodies or tokens.
  const data = await request('/api/hosts');
  for (const host of data.hosts) await record(`Panel host health: seen=${Boolean(host.last_seen_at)}; ${healthSummary(host.health)}`);
  const { stdout } = await command('sudo', ['docker', ...computeCompose, 'logs', '--no-log-prefix', '--tail', '100', 'compute-agent']);
  const reports = stdout.split('\n').flatMap(line => { try { const value = JSON.parse(line); return value.event === 'compute_health' ? [value] : []; } catch { return []; } });
  await record(`Agent local health: ${healthSummary(reports.at(-1))}`);
  const probe = `
    const base = process.env.CONTROL_PLANE_URL;
    for (const path of ['/health', '/api/compute/tunnel/authorize']) {
      try {
        const auth = path !== '/health';
        const response = await fetch(base + path, { method: auth ? 'POST' : 'GET',
          headers: auth ? { authorization: 'Bearer ' + process.env.COMPUTE_AGENT_TOKEN, 'content-type': 'application/json' } : {},
          ...(auth ? { body: JSON.stringify({ node_id: process.env.COMPUTE_NODE_ID }) } : {}), signal: AbortSignal.timeout(10000) });
        console.log(path + ': HTTP ' + response.status);
        await response.body?.cancel();
      } catch { console.log(path + ': transport failed'); }
    }`;
  const result = await command('sudo', ['docker', ...computeCompose, 'exec', '-T', 'compute-agent', 'node', '--input-type=module', '-e', probe]);
  for (const line of result.stdout.trim().split('\n')) {
    if (/^\/(health|api\/compute\/tunnel\/authorize): (HTTP \d{3}|transport failed)$/.test(line)) await record(`Agent connection: ${line}`);
  }
}
async function running(id) {
  return until(`environment ${id}`, async () => {
    const { environment } = await request(`/api/environments/${id}`);
    assert.notEqual(environment.state, 'degraded', `Environment failed: ${environment.error_message || environment.provisioning_step}`);
    return environment.state === 'running' && environment.runtime_id ? environment : null;
  }, 300);
}
async function ssh(environment, script, key = `${root}/key`) {
  return command('ssh', ['-o','BatchMode=yes','-o','StrictHostKeyChecking=accept-new','-o',`UserKnownHostsFile=${root}/known_hosts`,
    '-o','ConnectTimeout=10','-o','IdentitiesOnly=yes','-i',key,'-p',String(environment.ssh_port),
    `${environment.ssh_username}@${environment.ssh_host}`, script], { timeout: 180_000 });
}
async function terminal(id) {
  const ticket = await request(`/api/environments/${id}/terminal-ticket`, {});
  await new Promise((resolve, reject) => {
    const ws = new WebSocket(`${base.replace('http:', 'ws:')}${ticket.websocket_path}?token=${encodeURIComponent(ticket.token)}`);
    const timer = setTimeout(() => { ws.terminate(); reject(new Error('Terminal timed out')); }, 30_000);
    let output = '';
    ws.on('open', () => ws.send(Buffer.from("printf '\\144\\166-terminal-ok\\n'\r")));
    ws.on('message', data => { output += data.toString(); if (output.includes('dv-terminal-ok')) { clearTimeout(timer); ws.close(); resolve(); } });
    ws.on('error', error => { clearTimeout(timer); reject(error); });
  });
}
try {
  const config = await request('/api/config');
  assert.equal(config.installationMode, 'self-hosted'); assert.equal(config.termsUrl, null);
  const email = 'sysbox-qa@example.test'; const password = secret();
  await request('/api/auth/sign-up/email', { name: 'Sysbox QA', email, password });
  const { stdout: logs } = await command('docker', [...compose, 'logs', '--no-log-prefix', 'control-plane']);
  const mail = logs.split('\n').flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } }).find(m => m.event === 'email_preview' && m.to === email);
  assert.ok(mail, 'Verification email was not generated');
  const link = mail.text.match(/https?:\/\/\S+\/api\/auth\/verify-email\?\S+/)?.[0];
  assert.ok(link, 'Verification URL missing');
  assert.ok((await fetch(link, { redirect: 'manual' })).status < 400, 'Email verification failed');
  await request('/api/auth/sign-in/email', { email, password });
  const org = await request('/api/auth/organization/create', { name: 'Sysbox QA', slug: 'sysbox-qa', hostingMode: 'hybrid' });
  await request('/api/auth/organization/set-active', { organizationId: org.id });
  await command('docker', [...compose, 'exec', '-T', 'control-plane', 'npm', 'run', 'admin:grant', '--', '--email', email]);
  await record('Signup, email verification, organization creation and explicit admin bootstrap passed.');

  const installer = await fetch(`${base}/install/agent`).then(r => r.text());
  assert.ok(installer.includes(`DEFAULT_CONTROL_PLANE_URL='${base}'`), 'Installer is bound to the wrong panel');
  await writeFile(`${root}/agent.sh`, installer);
  const child = spawn('sudo', ['env', 'DRIFTVERK_INSTALL_DIR=/opt/driftverk-oss-qa', 'bash', `${root}/agent.sh`], { stdio: ['ignore','pipe','pipe'] });
  let installOutput = ''; child.stdout.on('data', data => { installOutput += data; }); child.stderr.on('data', data => { installOutput += data; });
  const installed = new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', code => code === 0 ? resolve() : reject(new Error(`Installer exited ${code}: ${installOutput.slice(-4000)}`))); });
  installed.catch(() => {});
  const code = await until('enrollment prompt', () => installOutput.match(/Confirm code: ([A-Z0-9-]+)/)?.[1]);
  await request('/api/compute-agent-setup/approve', { code });
  await installed;
  // On this single-VM test, use Docker DNS for container-to-panel traffic.
  // Keep Caddy in the path without relying on a host bridge IP or hairpin NAT.
  const { stdout: caddyId } = await command('docker', [...compose, 'ps', '-q', 'caddy']);
  assert.ok(caddyId.trim(), 'Caddy container missing');
  await command('sudo', ['docker', 'network', 'connect', '--alias', 'qa-panel',
    'driftverk-compute_default', caddyId.trim()]);
  await command('sudo', ['sed', '-i',
    's#http://localhost:8080#http://qa-panel#g;s#ws://localhost:8080#ws://qa-panel#g',
    '/opt/driftverk-oss-qa/.env.compute']);
  await command('sudo', ['docker', ...computeCompose, 'up', '-d', '--no-build'], { timeout: 180_000 });
  const hosts = await until('connected Sysbox host', async () => { const data = await request('/api/hosts'); return data.hosts.find(h => h.last_seen_at && h.health?.status === 'healthy'); })
    .catch(async error => {
      await hostDiagnostics().catch(() => record('Host diagnostics could not complete.'));
      throw error;
    });
  await record('Downloaded installer enrolled a real Sysbox host and established the data tunnel.');
  const billing = await request('/api/billing'); assert.equal(billing.complimentary, true); assert.equal(billing.payments_available, false);
  const created = await request('/api/environments', { name: 'original', source_type: 'image', image: 'driftverk-dev:1', compute_node_id: hosts.id,
    cpu: 1, memory_mb: 2048, disk_gb: 20, auto_stop_minutes: null, auto_delete_minutes: null });
  const original = await running(created.id);
  const { stdout: inspected } = await command('docker', ['inspect', original.runtime_id]);
  const runtime = JSON.parse(inspected)[0];
  assert.equal(runtime.HostConfig.Runtime, 'sysbox-runc'); assert.equal(runtime.HostConfig.Privileged, false);
  assert.ok(!runtime.Mounts.some(m => m.Source === '/var/run/docker.sock' || m.Destination === '/var/run/docker.sock'));
  await terminal(original.id);
  await command('ssh-keygen', ['-t','ed25519','-N','','-f',`${root}/key`]);
  await request('/api/ssh-keys', { name: 'QA', public_key: await readFile(`${root}/key.pub`, 'utf8') });
  assert.match((await ssh(original, "printf original > /workspace/qa-marker; cat /workspace/qa-marker")).stdout, /original/);
  await command('ssh-keygen', ['-t','ed25519','-N','','-f',`${root}/wrong-key`]);
  await assert.rejects(ssh(original, 'true', `${root}/wrong-key`), /Permission denied/);
  await record('Real terminal WebSocket and SSH commands passed; unregistered SSH key was rejected. Runtime is Sysbox without privileged mode or the host Docker socket.');

  const fixture = `const http=require('http'),crypto=require('crypto');const server=http.createServer((q,s)=>s.end('driftverk-preview-ok'));server.on('upgrade',(q,s)=>{const key=crypto.createHash('sha1').update(q.headers['sec-websocket-key']+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');s.write('HTTP/1.1 101 Switching Protocols\\r\\nUpgrade: websocket\\r\\nConnection: Upgrade\\r\\nSec-WebSocket-Accept: '+key+'\\r\\n\\r\\n');s.write(Buffer.concat([Buffer.from([129,5]),Buffer.from('hello')]));});server.listen(8765,'0.0.0.0');`;
  await ssh(original, `printf '%s' '${Buffer.from(fixture).toString('base64')}' | base64 -d > /workspace/qa-server.cjs; nohup node /workspace/qa-server.cjs > /tmp/qa-server.log 2>&1 < /dev/null &`);
  const grant = await request(`/api/environments/${original.id}/ports/8765/preview`, {});
  const ca = (await command('docker', [...compose, 'exec', '-T', 'caddy', 'cat', '/data/caddy/pki/authorities/local/root.crt'])).stdout;
  const tls = { ca, lookup: (_name, options, callback) => callback(null, options.all ? [{ address: host, family: 4 }] : host, 4) };
  const getPreview = (url, cookie = '') => new Promise((resolve, reject) => { https.get(url, { ...tls, signal: AbortSignal.timeout(15_000), headers: { Cookie: cookie } }, response => { let text = ''; response.on('data', d => { text += d; }); response.on('end', () => resolve({ status: response.statusCode, text, headers: response.headers })); }).on('error', reject); });
  const entrance = await getPreview(grant.url); assert.equal(entrance.status, 302);
  const previewCookie = entrance.headers['set-cookie'].map(value => value.split(';')[0]).join('; ');
  const page = await getPreview(new URL(entrance.headers.location, grant.url), previewCookie); assert.equal(page.status, 200); assert.equal(page.text, 'driftverk-preview-ok');
  const unsigned = await getPreview(new URL('/', grant.url)); assert.notEqual(unsigned.text, 'driftverk-preview-ok'); assert.ok(unsigned.text.includes(base));
  await new Promise((resolve, reject) => { const ws = new WebSocket(grant.url.replace('https:', 'wss:'), tls); const timer = setTimeout(() => { ws.terminate(); reject(new Error('Preview WS timed out')); }, 15_000); ws.on('message', d => { clearTimeout(timer); try { assert.equal(d.toString(), 'hello'); ws.close(); resolve(); } catch(e) { reject(e); } }); ws.on('error', e => { clearTimeout(timer); reject(e); }); });
  await record('Signed HTTP and WebSocket previews passed through Caddy with validated wildcard TLS using its local CA; unsigned preview did not reach the app.');

  const composeSmoke = Buffer.from(await readFile('images/dev/compose-smoke.sh')).toString('base64');
  assert.match((await ssh(original, `printf '%s' '${composeSmoke}' | base64 -d | sh`)).stdout, /Compose service responded over HTTP/);
  await record('Nested Docker Compose served HTTP.');
  assert.equal((await command('docker', ['exec', original.runtime_id, 'cat', '/workspace/qa-marker'])).stdout, 'original', 'Original marker before snapshot');
  await request(`/api/environments/${original.id}/actions`, { action: 'stop' });
  await until('source stopped before snapshot', async () => (await request(`/api/environments/${original.id}`)).environment.state === 'stopped');
  const snap = await request('/api/snapshots', { environment_id: original.id, name: 'round-trip' });
  await until('snapshot ready', async () => { const data = await request('/api/snapshots'); const snapshot = data.snapshots.find(s => s.id === snap.id); assert.notEqual(snapshot?.status, 'failed'); return snapshot?.status === 'ready'; }, 300);
  // Inspect the captured filesystem before Sysbox starts a restored runtime.
  const snapshotImage = `driftverk/snapshot-${snap.id.toLowerCase()}:latest`;
  const imageId = (await command('docker', ['image', 'inspect', '--format', '{{.Id}}', snapshotImage])).stdout.trim();
  const probeId = (await command('docker', ['create', '--runtime', 'runc', '--entrypoint', '/bin/true', snapshotImage])).stdout.trim();
  try {
    await command('docker', ['cp', `${probeId}:/workspace/qa-marker`, `${root}/captured-marker`]);
    assert.equal(await readFile(`${root}/captured-marker`, 'utf8'), 'original', 'Marker in captured image before restore');
  } finally {
    await command('docker', ['rm', probeId]);
  }
  await record('Snapshot image contains the marker before starting the restored runtime.');
  const restored = await request('/api/environments', { name: 'restored', source_type: 'snapshot', snapshot_id: snap.id, compute_node_id: hosts.id, cpu: 1, memory_mb: 2048, disk_gb: 20, auto_stop_minutes: null });
  const copy = await running(restored.id);
  const restoredImageId = (await command('docker', ['inspect', '--format', '{{.Image}}', copy.runtime_id])).stdout.trim();
  assert.equal(restoredImageId, imageId, 'Restored runtime must use the captured image');
  await record('Restored runtime uses the captured image ID.');
  assert.equal((await command('docker', ['exec', copy.runtime_id, 'cat', '/workspace/qa-marker'])).stdout, 'original', 'Restored marker read directly through Docker');
  await record('Snapshot marker verified directly in the restored container.');
  assert.equal((await ssh(copy, 'cat /workspace/qa-marker')).stdout, 'original', 'Restored marker read through SSH');
  await ssh(copy, 'printf restored > /workspace/qa-marker');
  assert.equal((await command('docker', ['exec', copy.runtime_id, 'cat', '/workspace/qa-marker'])).stdout, 'restored', 'Restored container accepts independent writes');
  await request(`/api/environments/${original.id}/actions`, { action: 'start' });
  await running(original.id);
  assert.equal((await ssh(original, 'cat /workspace/qa-marker')).stdout.trim(), 'original');
  await record('Filesystem snapshot restored the marker into an independent environment.');
  await request(`/api/environments/${original.id}/actions`, { action: 'delete' });
  await request(`/api/environments/${copy.id}/actions`, { action: 'delete' });
  await until('environment deletion', async () => {
    const { stdout } = await command('docker', ['ps', '-aq', '--filter', `id=${original.runtime_id}`, '--filter', `id=${copy.runtime_id}`]);
    return !stdout.trim();
  });
  await request(`/api/snapshots/${snap.id}`, undefined, 'DELETE');
  assert.ok(!(await request('/api/snapshots')).snapshots.some(s => s.id === snap.id));
  await record('Environment deletion and snapshot removal were acknowledged.');
  await record('Self-hosted end-to-end checks passed. Scope: one disposable Ubuntu host, local snapshot storage and private-CA TLS.');
} catch (error) {
  await record(`FAILED: ${error.message}`);
  process.exitCode = 1;
}
