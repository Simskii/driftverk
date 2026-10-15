import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { DockerSandboxRuntime } from './docker-runtime.mjs';
const exec = promisify(execFile);

test('real shutdown sends SIGTERM, retains files on resume, and force-stops after grace', {
  skip: process.env.DRIFTVERK_RUNTIME_QA !== '1', timeout: 60000,
}, async () => {
  const runtime = new DockerSandboxRuntime();
  for (const graceful of [true, false]) {
    let id;
    try {
      const script = graceful
        ? "trap 'echo terminated > /tmp/shutdown; exit 0' TERM; touch /tmp/ready; while :; do sleep 1 & wait $!; done"
        : "trap '' TERM; touch /tmp/ready; while :; do sleep 1; done";
      id = (await exec('docker', ['run','-d','--network','none','--label','driftverk.qa=shutdown','node:22-alpine','sh','-c',script])).stdout.trim();
      await exec('docker',['exec',id,'sh','-c','while [ ! -f /tmp/ready ]; do sleep 0.1; done']);
      const started = Date.now();
      await runtime.stop({runtime_id:id});
      const elapsed = Date.now() - started;
      const state = JSON.parse((await exec('docker',['inspect','--format','{{json .State}}',id])).stdout);
      assert.equal(state.Running,false);
      assert.equal(state.ExitCode,graceful ? 0 : 137);
      if (graceful) {
        assert.ok(elapsed < 15000,'cooperative process exits before grace expires');
        await runtime.start({runtime_id:id,resources:{cpu:1,memory_mb:1024}});
        assert.equal((await exec('docker',['exec',id,'cat','/tmp/shutdown'])).stdout.trim(),'terminated');
      } else assert.ok(elapsed >= 29000 && elapsed < 45000,'uncooperative process receives the 30-second grace');
    } finally {
      if (id) await exec('docker',['rm','-f',id]);
    }
  }
});
