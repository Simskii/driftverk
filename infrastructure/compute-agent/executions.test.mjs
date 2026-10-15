import assert from 'node:assert/strict';
import test from 'node:test';
import { ExecutionRuntime, processExecutions } from './executions.mjs';
const execution = { id: 'exec_00000000-0000-4000-8000-000000000001', runtime_id: 'local-runtime', environment_state: 'running' };

test('confirmed removed runtime produces lost instead of retrying forever', async () => {
  const runtime = new ExecutionRuntime(async (_command, args) => {
    if (args[0] === 'ps') return { stdout: '' };
    throw new Error('Container unavailable');
  });
  const reports = [];
  await processExecutions(async (path, value) => path.endsWith('/poll') ? { executions: [execution] } : reports.push(value), runtime);
  assert.deepEqual(reports, [{ status: 'lost', exit_code: null, artifacts: [] }]);
});

test('Docker transport failure remains retryable and never fabricates a terminal result', async () => {
  const runtime = new ExecutionRuntime(async () => { throw new Error('Docker unavailable'); });
  const reports = [];
  await assert.rejects(processExecutions(async (path, value) => path.endsWith('/poll') ? { executions: [execution] } : reports.push(value), runtime), /Docker unavailable/);
  assert.equal(reports.length, 0);
});

test('missing required Python supervisor produces a terminal lost result', async () => {
  const runtime = new ExecutionRuntime(async () => { throw new Error('exec: "python3": executable file not found in $PATH'); });
  const reports = [];
  await processExecutions(async (path, value) => path.endsWith('/poll') ? { executions: [execution] } : reports.push(value), runtime);
  assert.equal(reports[0].status, 'lost');
});


test('execution secrets travel only on start stdin, never command arguments or status payloads', async () => {
  const calls = [];
  const runtime = new ExecutionRuntime(async (_command, args, options) => {
    calls.push({ args, options });
    return { stdout: '{}' };
  });
  const job = { ...execution, environment_variables: { PREVIEW_GITHUB_TOKEN: 'fixture-secret' } };
  await runtime.start(job);
  await runtime.status(job);
  assert.equal(JSON.stringify(calls[0].args).includes('fixture-secret'), false);
  assert.equal(JSON.parse(calls[0].options.stdin).environment_variables.PREVIEW_GITHUB_TOKEN, 'fixture-secret');
  assert.equal(calls[1].options.stdin.includes('fixture-secret'), false);
});
