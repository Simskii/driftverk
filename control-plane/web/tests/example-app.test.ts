import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { exampleApp, exampleEditCommand } from '../src/example-app.ts';
import { parseDevelopmentConfig } from '../../src/development-config.ts';
const exec = promisify(execFile);

test('example initializes, serves HTTP, and reflects a terminal edit without restart', { timeout: 15000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'driftverk-example-'));
  let server: ReturnType<typeof spawn> | undefined;
  try {
    assert.equal(parseDevelopmentConfig(exampleApp).workspace_path, '/workspace');
    await exec('sh', ['-eu', '-c', exampleApp.initialization_command], { cwd: directory });
    server = spawn(process.execPath, [join(directory, 'driftverk-example/server.cjs')], { env: { ...process.env, PORT: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
    const port = await new Promise<string>((resolve, reject) => {
      server!.stdout!.once('data', data => {
        const match = String(data).match(/listening on (\d+)/);
        if (match) resolve(match[1]!); else reject(new Error(String(data)));
      });
      server!.once('error', reject);
      server!.once('exit', code => reject(new Error(`Server exited: ${code}`)));
    });
    const response = await fetch(`http://127.0.0.1:${port}`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.match(await response.text(), /Your environment is live\./);
    await exec('sh', ['-c', exampleApp.readiness_command], { env: { ...process.env, PORT: port } });
    await exec('sh', ['-c', exampleEditCommand.replace('/workspace', directory)]);
    const updated = await (await fetch(`http://127.0.0.1:${port}`)).text();
    assert.match(updated, /I changed this from my environment\./);
    assert.doesNotMatch(updated, /Your environment is live\./);
    server.kill();
    await new Promise(resolve => server!.once('exit', resolve));
    server = undefined;
    await assert.rejects(exec('sh', ['-c', exampleApp.readiness_command], { env: { ...process.env, PORT: port } }));
  } finally {
    server?.kill();
    await rm(directory, { recursive: true, force: true });
  }
});
