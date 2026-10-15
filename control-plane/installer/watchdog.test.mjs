import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

async function fixture(t, settings = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'driftverk-watchdog-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, 'bin'));
  await writeFile(join(dir, '.env.compute'), 'DOCKER_RUNTIME=sysbox-runc\n');
  const scripts = {
    flock: 'exit 0',
    timeout: 'shift; exec "$@"',
    date: 'echo "$TEST_NOW"',
    systemctl: `
if [ "$1" = start ] || [ "$1" = restart ]; then echo "$1 $2" >> "$TEST_LOG"; exit 1; fi
service="\${@: -1}"
state=active
if [ "$service" = sysbox-fs ]; then state="$TEST_SYSBOX"; fi
if [ "$service" = docker ]; then state="$TEST_DOCKER"; fi
if [ "$2" != --quiet ]; then echo "$state"; fi
[ "$state" = active ]`,
    docker: `
case "$1" in
 info) exit 0;;
 ps) [ -z "$TEST_RUNTIME" ] || echo workload; exit 0;;
 compose) echo "\${@: -1}";;
 inspect) if [ "$3" = '{{.HostConfig.Runtime}}' ]; then echo "$TEST_RUNTIME"; else echo "running $TEST_CONTAINER"; fi;;
 restart) echo "restart \${@: -1}" >> "$TEST_LOG";;
esac`,
  };
  for (const [name, body] of Object.entries(scripts)) await writeFile(join(dir, 'bin', name), `#!/bin/bash\n${body}\n`, { mode: 0o755 });
  const run = async (now = 1000) => {
    const result = spawnSync('bash', [fileURLToPath(new URL('./watchdog.sh', import.meta.url))], { encoding: 'utf8', env: { ...process.env, PATH: `${dir}/bin:${process.env.PATH}`, DRIFTVERK_INSTALL_DIR: dir, DRIFTVERK_HEALTH_DIR: join(dir, 'health'), TEST_LOG: join(dir, 'actions'), TEST_NOW: String(now), TEST_SYSBOX: 'active', TEST_DOCKER: 'active', TEST_RUNTIME: '', TEST_CONTAINER: 'healthy', ...settings } });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(await readFile(join(dir, 'health/status.json'), 'utf8'));
  };
  return { run, actions: () => readFile(join(dir, 'actions'), 'utf8').catch(() => '') };
}

test('failed Sysbox with active environments never starts services', async t => {
  const f = await fixture(t, { TEST_SYSBOX: 'failed', TEST_RUNTIME: 'sysbox-runc' });
  const report = await f.run();
  assert.match(report.checks.find(c => c.service === 'sysbox').message, /active environments/);
  assert.equal(await f.actions(), '');
});
test('intentionally inactive services are not started', async t => {
  const f = await fixture(t, { TEST_SYSBOX: 'inactive', TEST_DOCKER: 'inactive' });
  await f.run();
  assert.equal(await f.actions(), '');
});
test('recovery is backed off and capped at three attempts across runs', async t => {
  const f = await fixture(t, { TEST_SYSBOX: 'failed' });
  await f.run(1000);
  await f.run(1010);
  assert.equal(await f.actions(), '');
  await f.run(1040);
  await f.run(1050);
  assert.equal(await f.actions(), 'restart sysbox\n');
  await f.run(2000);
  await f.run(3000);
  const report = await f.run(4000);
  assert.equal(await f.actions(), 'restart sysbox\n'.repeat(3));
  assert.match(report.checks.find(c => c.service === 'sysbox').message, /exhausted/);
});
test('unhealthy infrastructure containers are restarted by exact id', async t => {
  const f = await fixture(t, { TEST_CONTAINER: 'unhealthy' });
  await f.run();
  await f.run(1040);
  assert.equal(await f.actions(), 'restart compute-agent\nrestart preview-gateway\nrestart web-terminal\n');
});
