// Collect shipped dependency license/notice text, rather than SPDX labels alone.
// Usage: node scripts/third-party-npm.mjs PACKAGE_DIRECTORY OUTPUT_FILE
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

const [directory, output] = process.argv.slice(2);
if (!directory || !output) throw new Error('Expected package directory and output file');
const lock = JSON.parse(await readFile(path.join(directory, 'package-lock.json'), 'utf8'));
const sections = ['Third-party notices\n\nRuntime dependency inventory. This includes server dependencies as well as browser dependencies. Each component retains its own terms.\n'];
for (const [location, entry] of Object.entries(lock.packages).sort()) {
  if (!location || entry.dev || entry.link) continue;
  const installed = path.join(directory, location);
  let names;
  try { names = await readdir(installed); }
  catch (error) {
    if (entry.optional && error.code === 'ENOENT') continue;
    throw error;
  }
  const manifest = JSON.parse(await readFile(path.join(installed, 'package.json'), 'utf8'));
  let legal = names.filter(name => /^(licen[sc]e|copying|notice|copyright|authors)([._-].*)?$/i.test(name));
  if (!legal.length) legal = names.filter(name => /^readme([._-].*)?$/i.test(name));
  if (!legal.length) throw new Error(`Missing upstream legal text for ${manifest.name}@${manifest.version}`);
  sections.push(`\n===== ${manifest.name}@${manifest.version} =====\nDeclared license: ${JSON.stringify(manifest.license ?? entry.license ?? 'not declared')}\nPackage: ${entry.resolved ?? location}\n`);
  for (const name of legal.sort()) {
    sections.push(`\n--- ${name} ---\n${await readFile(path.join(installed, name), 'utf8')}\n`);
  }
  if (manifest.name === 'standardwebhooks' && manifest.version === '1.0.0') {
    const source = 'https://raw.githubusercontent.com/standard-webhooks/standard-webhooks/929bf0c1928b188287eaf88d0a9f0a4e87df6499/libraries/LICENSE';
    sections.push(`\n--- Upstream license from ${source} ---\n${await readFile(new URL('third-party-licenses/standardwebhooks-1.0.0.txt', import.meta.url), 'utf8')}\n`);
  }
  if (manifest.name === '@better-auth/utils' && ['0.4.2', '0.5.0'].includes(manifest.version)) {
    // These MIT-declared release tags precede the upstream license-only addition.
    // Keep the actual project notice, including its author's attribution, verbatim.
    const source = 'https://raw.githubusercontent.com/better-auth/utils/ef522888b7b2ff77ca13f0afb476dfae8f297862/LICENSE';
    const license = await readFile(new URL('third-party-licenses/better-auth-utils-0.4.2.txt', import.meta.url));
    if (createHash('sha256').update(license).digest('hex') !== 'b5052b5db9a8720634e5243aaf019269ddd93c2e43f46a09f72b99e0004c8680') {
      throw new Error('Upstream @better-auth/utils license supplement checksum mismatch');
    }
    sections.push(`\n--- Upstream project license added after this release, from ${source} ---\n${license.toString('utf8')}\n`);
  }
}
await mkdir(path.dirname(output), { recursive: true });
await writeFile(output, sections.join(''));
