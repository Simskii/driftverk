import test from 'node:test';
import assert from 'node:assert/strict';
import { checkHealth, canClaimJobs, allowedOperations } from './health.mjs';

const options = { docker: async () => {}, probe: async () => {}, request: async () => ({ ok: true }), sysbox: true, tunnelConnected: true, now: 100000 };
test('healthy dependencies permit jobs, stale and initial health block them', async () => {
  const health = await checkHealth(options);
  assert.equal(canClaimJobs(health, 100000), true);
  assert.equal(canClaimJobs(health, 150000), false);
  assert.equal(canClaimJobs(null), false);
});
test('dead Sysbox blocks jobs even when Docker responds', async () => {
  const health = await checkHealth({ ...options, probe: async target => { if (target.path?.endsWith('sysfs.sock')) throw new Error('connection refused'); } });
  assert.equal(canClaimJobs(health, 100000), false);
  assert.equal(health.checks.find(c => c.service === 'sysbox-fs').status, 'unhealthy');
  assert.deepEqual(allowedOperations(health, ['create', 'start', 'stop', 'delete', 'snapshot'], 100000), ['stop', 'delete']);
  assert.deepEqual(allowedOperations(health, ['stop'], 200000), []);
});
test('watchdog staleness, recovery and disconnected tunnel block jobs', async () => {
  for (const override of [
    { tunnelConnected: false },
    { watchdogFile: 'status.json', read: async () => JSON.stringify({ checked_at: 1, checks: [] }) },
    { watchdogFile: 'status.json', read: async () => JSON.stringify({ checked_at: 100000, checks: [{ service: 'sysbox', status: 'recovering' }] }) },
  ]) assert.equal(canClaimJobs(await checkHealth({ ...options, ...override }), 100000), false);
});
