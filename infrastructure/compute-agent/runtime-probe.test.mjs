import test from 'node:test';
import assert from 'node:assert/strict';
import { probeRuntime } from './runtime-probe.mjs';
import { DockerSandboxRuntime } from './docker-runtime.mjs';

const fault = new Error('unsafe procfs detected: openat2 fsmount:fscontext:proc/thread-self/fd/: operation not permitted');
test('only confirmed Sysbox failure permits recovery, not timeout or missing tools', async () => {
  assert.equal(await probeRuntime(async () => ({}), 'abcdef123456'), 'healthy');
  assert.equal(await probeRuntime(async () => { throw fault; }, 'abcdef123456'), 'sysbox-failed');
  for (const message of ['timeout', 'executable file not found', 'Docker unavailable']) {
    assert.equal(await probeRuntime(async () => { throw new Error(message); }, 'abcdef123456'), 'unavailable');
  }
});
test('recovery stops only the broken runtime and retries do not restart a healthy runtime', async () => {
  let broken = true;
  const calls = [];
  const runtime = new DockerSandboxRuntime({
    volumeStorage: { prepare: async () => {} },
    runner: async (command, args) => {
      calls.push([command, ...args]);
      if (command === 'timeout' && broken) throw fault;
      if (args[0] === 'start') broken = false;
      if (args[0] === 'inspect') return { stdout: 'sysbox-runc' };
      return { stdout: '' };
    },
  });
  runtime.startProject = async () => {};
  const sandbox = { runtime_id: 'abcdef123456', runtime_recovery: true, resources: { cpu: 2, memory_mb: 4096 } };
  await runtime.start(sandbox);
  await runtime.start(sandbox);
  assert.equal(calls.filter(call => call[1] === 'stop').length, 1);
});
test('unknown failure in a running runtime never restarts it', async () => {
  const runtime = new DockerSandboxRuntime({ runner: async (command, args) => {
    if (command === 'timeout') throw new Error('timeout');
    assert.equal(args[0], 'inspect');
    return { stdout: 'running' };
  } });
  await assert.rejects(runtime.start({runtime_id:'abcdef123456',runtime_recovery:true}), /without a confirmed/);
});
