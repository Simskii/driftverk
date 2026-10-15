import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { agentTerminalCommand } from './agent-terminal.mjs';
import { managedCodexArguments, prepareAgentConnection, connectionPath } from './agent-connection.mjs';

test('managed launcher skips device login, strips API keys and separates accounts', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-connected-test-'));
  try {
    await writeFile(join(directory, 'codex'), '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "codex-cli 0.154.0"; exit; fi\n[ -z "$OPENAI_API_KEY" ] || exit 3\nprintf "%s\\n" "$@"\n', { mode: 0o700 });
    const command = account => agentTerminalCommand({ id: 'codex', auth_method: 'subscription', connection_id: 'fixture', account_id: account, model: 'fixture-model' });
    // Use the real launcher, with only its directory and tmux discovery replaced.
    const script = command('account-a')[2].replace("cd '/workspace'", `cd '${directory}'`).replace('if command -v tmux >/dev/null 2>&1;', 'if false;');
    const result = spawnSync('/bin/sh', ['-c', script], { encoding: 'utf8', env: { PATH: `${directory}:${process.env.PATH}`, HOME: directory, OPENAI_API_KEY: 'must-not-use' } });
    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.stdout.includes('model_provider="driftverk_chatgpt"'));
    assert.ok(!result.stdout.includes('login'));
    assert.match(result.stdout, /fixture-model/);
    assert.notEqual(command('account-a')[2].match(/tmux -L (\S+)/)[1], command('account-b')[2].match(/tmux -L (\S+)/)[1]);
    await writeFile(join(directory, 'codex'), '#!/bin/sh\necho "codex-cli 0.153.4"\n', { mode: 0o700 });
    const old = spawnSync('/bin/sh', ['-c', script], { encoding: 'utf8', env: { PATH: `${directory}:${process.env.PATH}`, HOME: directory } });
    assert.equal(old.status, 1);
    assert.match(old.stdout, /Update Codex/);
    assert.ok(!managedCodexArguments().join(' ').includes('refresh_token'));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('connection setup rejects credential redirect and insecure external destinations', async () => {
  for (const url of ['http://example.com/api/agent-credentials/codex', 'https://user:password@example.com/api/agent-credentials/codex', 'https://example.com/other'])
    await assert.rejects(prepareAgentConnection({}, { url, token: 'fixture', account_id: 'fixture' }), /Invalid/);
});

test('connection grant is delivered through stdin into tmpfs and excluded from snapshots', { skip: !process.env.DRIFTVERK_AGENT_TEST_IMAGE }, async () => {
  const { default: Docker } = await import('dockerode');
  const docker = new Docker();
  const container = await docker.createContainer({ Image: process.env.DRIFTVERK_AGENT_TEST_IMAGE, Entrypoint: ['sleep'], Cmd: ['infinity'], HostConfig: { NetworkMode: 'none' }, Labels: { 'driftverk.qa': 'connected-agent' } });
  let snapshot, restored;
  try {
    await container.start();
    await prepareAgentConnection(container, { url: 'https://example.com/api/agent-credentials/codex', token: 'fixture-session-grant', account_id: 'fixture' });
    async function exists(target) {
      const exec = await target.exec({ Cmd: ['test', '-f', connectionPath('fixture')], AttachStdout: true, AttachStderr: true });
      const stream = await exec.start(); stream.resume();
      await new Promise(resolve => stream.on('end', resolve));
      return (await exec.inspect()).ExitCode === 0;
    }
    assert.equal(await exists(container), true);
    assert.ok(!JSON.stringify((await container.inspect()).Config).includes('fixture-session-grant'));
    snapshot = await container.commit();
    restored = await docker.createContainer({ Image: snapshot.Id, Entrypoint: ['sleep'], Cmd: ['infinity'], HostConfig: { NetworkMode: 'none' }, Labels: { 'driftverk.qa': 'connected-agent' } });
    await restored.start();
    assert.equal(await exists(restored), false, 'grant must not survive a filesystem snapshot');
  } finally {
    if (restored) await restored.remove({ force: true });
    await container.remove({ force: true });
    if (snapshot) await docker.getImage(snapshot.Id).remove();
  }
});
