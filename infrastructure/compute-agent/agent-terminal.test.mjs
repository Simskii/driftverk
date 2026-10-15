import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { agentTerminalCommand } from './agent-terminal.mjs';
import { terminalCommand } from './persistent-terminal.mjs';

test('subscription launch uses device login and strips API credentials before starting', () => {
  const directory = mkdtempSync(join(tmpdir(), 'driftverk-subscription-test-'));
  try {
    symlinkSync('/bin/mkdir', join(directory, 'mkdir'));
    for (const id of ['codex', 'claude']) {
      writeFileSync(join(directory, id), `#!/bin/sh
[ -z "$OPENAI_API_KEY$ANTHROPIC_API_KEY$ANTHROPIC_AUTH_TOKEN$CLAUDE_CODE_OAUTH_TOKEN" ] || exit 9
if [ "$1" = login ]; then
  [ "$2" = status ] && exit 1
  [ "$2" = --device-auth ] || exit 8
  printf 'device-login\\n'
else
  printf 'subscription-agent\\n'
fi
`, { mode: 0o700 });
      const script = agentTerminalCommand({ id, auth_method: 'subscription' })[2];
      const result = spawnSync('/bin/sh', ['-c', `cd() { return 0; }\n${script}`], { env: { HOME: directory, PATH: directory, OPENAI_API_KEY: 'fixture', ANTHROPIC_API_KEY: 'fixture', ANTHROPIC_AUTH_TOKEN: 'fixture', CLAUDE_CODE_OAUTH_TOKEN: 'fixture' }, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, id === 'codex' ? 'device-login\nsubscription-agent\n' : 'subscription-agent\n');
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('agent terminals reject command injection and unsafe workspace paths', () => {
  for (const agent of [
    { id: 'codex;exit' }, { id: 'codex', model: '$(touch /tmp/bad)' },
    { id: 'claude', model: '--dangerously-skip-permissions' },
    { id: 'codex', workspace_path: '/workspaces/../etc' },
    { id: 'codex', workspace_path: '/workspace/project;exit' },
  ]) assert.throws(() => agentTerminalCommand(agent));
});

test('agent launch passes model as one argument and uses separate persistent sessions', () => {
  for (const id of ['codex', 'claude']) {
    const command = agentTerminalCommand({ id, model: 'model-1', workspace_path: '/workspaces/project' });
    const syntax = spawnSync('/bin/sh', ['-n'], { input: command[2], encoding: 'utf8' });
    assert.equal(syntax.status, 0, syntax.stderr);
    assert.ok(command[2].includes(`-L driftverk-agent-${id}`));
    assert.ok(!command[2].includes('dangerously'));
    assert.ok(!command[2].includes('yolo'));
    assert.ok(terminalCommand('web')[2].includes('-L driftverk new-session'));
  }
});

test('missing tools fail with an actionable message before authentication or changing directory', () => {
  const command = agentTerminalCommand({ id: 'codex' });
  const result = spawnSync('/bin/sh', ['-c', `command() { return 1; }\n${command[2]}`], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /codex is not installed/);
  assert.ok(!result.stderr);
});

test('Codex gets its key through stdin without exposing it in command arguments', () => {
  const directory = mkdtempSync(join(tmpdir(), 'driftverk-agent-test-'));
  try {
    writeFileSync(join(directory, 'codex'), `#!/bin/sh
if [ "$1" = login ]; then
  [ "$2" = --with-api-key ] && read -r value && [ "$value" = "$OPENAI_API_KEY" ]
  exit $?
fi
printf 'launch'; for arg do printf ' <%s>' "$arg"; done
`, { mode: 0o700 });
    writeFileSync(join(directory, 'printenv'), `#!/bin/sh
printf '%s\\n' "$OPENAI_API_KEY"
`, { mode: 0o700 });
    const script = agentTerminalCommand({ id: 'codex', model: 'model-1' })[2];
    const result = spawnSync('/bin/sh', ['-c', `cd() { return 0; }\n${script}`], {
      env: { PATH: directory, OPENAI_API_KEY: 'fixture-only' }, encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, 'launch <--model> <model-1>');
    assert.ok(!result.stdout.includes('fixture-only'));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
