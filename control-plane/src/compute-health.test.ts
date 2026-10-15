import test from 'node:test';
import assert from 'node:assert/strict';
import { parseComputeHealth } from './compute-health.js';

test('health status is derived from checks rather than a caller claim', () => {
  assert.equal(parseComputeHealth({ status: 'healthy', checks: [{ service: 'sysbox', status: 'unhealthy' }] })?.status, 'unhealthy');
  assert.equal(parseComputeHealth({ checks: [{ service: 'docker', status: 'healthy' }] })?.status, 'healthy');
});
test('health reports are bounded and reject malformed checks', () => {
  for (const value of [null, {}, { checks: [] }, { checks: Array(17).fill({}) }, { checks: [{ service: 'bad service', status: 'healthy' }] }]) assert.equal(parseComputeHealth(value), null);
  assert.equal(parseComputeHealth({ checks: [{ service: 'docker', status: 'unhealthy', message: 'x'.repeat(1000) }] })?.checks[0]?.message.length, 300);
});
