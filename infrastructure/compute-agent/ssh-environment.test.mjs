import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { sshEnvironment } from './persistent-terminal.mjs';

test('SSH default passes the Codex remote login shell probe', () => {
  const probe = 'if [ -z "$SHELL" ] || [ ! -x "$SHELL" ]; then exit 127; fi; exec "$SHELL" -lc "printf ready"';
  assert.equal(spawnSync('/bin/sh', ['-c', 'unset SHELL; ' + probe], { env: {} }).status, 127);
  const env = Object.fromEntries(sshEnvironment().map((entry) => entry.split('=')));
  const result = spawnSync('/bin/sh', ['-c', probe], { env, encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, 'ready');
});

test('SSH preserves image shell and environment overrides without copying other image values', () => {
  assert.deepEqual(sshEnvironment(['SHELL=/bin/bash', 'OTHER=image']), ['SHELL=/bin/bash']);
  assert.deepEqual(sshEnvironment(['SHELL=/bin/bash'], { SHELL: '/bin/zsh', VALUE: 'a=b' }), ['SHELL=/bin/zsh', 'VALUE=a=b']);
  assert.deepEqual(sshEnvironment(['SHELL=']), ['SHELL=/bin/sh']);
});
