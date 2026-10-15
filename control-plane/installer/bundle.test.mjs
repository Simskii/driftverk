import test from 'node:test';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';

test('every compute Dockerfile source is shipped and downloaded by the installer', async () => {
  const root = new URL('../../', import.meta.url);
  const dockerfile = await readFile(new URL('infrastructure/compute-agent/Dockerfile', root), 'utf8');
  const installer = await readFile(new URL('control-plane/installer/agent.sh', root), 'utf8');
  const server = await readFile(new URL('control-plane/src/app.ts', root), 'utf8');
  // Exercise the download list, including shell loops, without making requests.
  const downloads = installer.match(/download_bundle_file compose\.compute\.yaml[\s\S]*?(?=\nif \[ "\$new_registration")/);
  assert.ok(downloads, 'installer download block exists');
  const shipped = new Set(execFileSync('bash', ['-c', `download_bundle_file() { printf '%s\\n' "$1"; }\n${downloads[0]}`], { encoding: 'utf8' }).trim().split('\n'));
  for (const line of dockerfile.split('\n').filter(line => line.startsWith('COPY '))) {
    const sources = line.trim().split(/\s+/).slice(1, -1);
    for (const source of sources) {
      const path = `infrastructure/compute-agent/${source}`;
      await access(new URL(path, root));
      assert.ok(server.includes(`"${path}"`), `${path} missing from bundle allowlist`);
      assert.ok(shipped.has(path), `${path} missing from installer downloads`);
    }
  }
});
