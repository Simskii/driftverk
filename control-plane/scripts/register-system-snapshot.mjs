import { createHash } from 'node:crypto';
import pg from 'pg';

// Usage: DATABASE_URL=... node scripts/register-system-snapshot.mjs VERSION ghcr.io/OWNER/dev@sha256:DIGEST
const [version, image] = process.argv.slice(2);
if (!/^[0-9]{4}\.[0-9]{2}\.[0-9]+$/.test(version ?? '') || !/^ghcr\.io\/[a-z0-9/._-]+@sha256:[a-f0-9]{64}$/.test(image ?? ''))
  throw new Error('Usage: register-system-snapshot.mjs YYYY.MM.N ghcr.io/OWNER/dev@sha256:DIGEST');
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');

// Anonymous access is intentional: every Cloud/Hybrid host must be able to pull.
const [repository, digest] = image.slice('ghcr.io/'.length).split('@');
const tokenResponse = await fetch(`https://ghcr.io/token?service=ghcr.io&scope=${encodeURIComponent(`repository:${repository}:pull`)}`, { signal: AbortSignal.timeout(30_000) });
if (!tokenResponse.ok) throw new Error('Image is not publicly accessible in GHCR');
const { token } = await tokenResponse.json();
const manifestResponse = await fetch(`https://ghcr.io/v2/${repository}/manifests/${digest}`, {
  headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json' },
  signal: AbortSignal.timeout(30_000),
});
if (!manifestResponse.ok) throw new Error('Published image manifest is unavailable');
const bytes = Buffer.from(await manifestResponse.arrayBuffer());
if (`sha256:${createHash('sha256').update(bytes).digest('hex')}` !== digest) throw new Error('Manifest digest mismatch');
const manifest = JSON.parse(bytes.toString());
for (const architecture of ['amd64', 'arm64']) {
  if (!manifest.manifests?.some(item => item.platform?.os === 'linux' && item.platform?.architecture === architecture))
    throw new Error(`Release is missing linux/${architecture}`);
}

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
try {
  await client.query('BEGIN');
  await client.query("SELECT pg_advisory_xact_lock(hashtext('driftverk-system-snapshot-release'))");
  const id = `sys_driftverk-dev-${version}`;
  const existing = await client.query('SELECT image_ref FROM system_snapshots WHERE id = $1', [id]);
  if (existing.rows[0] && existing.rows[0].image_ref !== image) throw new Error('This release already references another digest; publish a new version');
  await client.query('UPDATE system_snapshots SET is_default = false WHERE is_default');
  await client.query(`INSERT INTO system_snapshots (id, name, version, image_ref, is_default)
    VALUES ($1, 'Driftverk Dev', $2, $3, true)
    ON CONFLICT (id) DO UPDATE SET is_default = true`, [id, version, image]);
  await client.query('COMMIT');
  console.log(`Default system snapshot: ${id} (${image})`);
} catch (error) {
  await client.query('ROLLBACK');
  throw error;
} finally {
  await client.end();
}
