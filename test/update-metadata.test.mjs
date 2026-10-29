import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const execute = promisify(execFile);
const script = fileURLToPath(new URL('../scripts/release-metadata.mjs', import.meta.url));
const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const checksum = bytes => createHash('sha256').update(bytes).digest('hex');

test('release metadata hashes actual matching root-version ZIP and DMG artifacts for either build output', async t => {
  for (const mode of ['release', 'adhoc']) {
    const directory = await mkdtemp(path.join(tmpdir(), `recruiters-${mode}-metadata-`));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const zip = `recruiters-rip-companion-${version}-mac-arm64.zip`;
    const dmg = `recruiters-rip-companion-${version}-mac-arm64.dmg`;
    const zipBytes = Buffer.from(`synthetic ${mode} ZIP artifact`), dmgBytes = Buffer.from(`synthetic ${mode} DMG artifact`);
    await writeFile(path.join(directory, zip), zipBytes);
    await writeFile(path.join(directory, dmg), dmgBytes);
    await writeFile(path.join(directory, 'recruiters-rip-companion-0.0.0-mac-arm64.zip'), 'unrelated old version');
    await execute(process.execPath, [script, directory], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
    assert.equal(await readFile(path.join(directory, 'SHA256SUMS.txt'), 'utf8'), `${checksum(zipBytes)}  ${zip}\n${checksum(dmgBytes)}  ${dmg}\n`);
    assert.equal((await readdir(directory)).some(name => name.endsWith('.tmp')), false);
    assert.equal(await readFile(path.join(directory, zip), 'utf8'), zipBytes.toString());
  }
});

test('metadata refuses to manufacture a download when current-version artifacts are absent', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'recruiters-missing-release-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await assert.rejects(execute(process.execPath, [script, directory], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } }), error => error.stderr.includes('Missing supported current-version release artifacts'));
  assert.deepEqual(await readdir(directory), []);
});

for (const suffix of ['win-x64.exe', 'linux-x64.AppImage']) test(`metadata hashes ${suffix} without demanding a macOS ZIP`, async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'recruiters-platform-metadata-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const name = `recruiters-rip-companion-${version}-${suffix}`;
  await writeFile(path.join(directory, name), 'synthetic installer');
  await execute(process.execPath, [script, directory], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
  assert.equal(await readFile(path.join(directory, 'SHA256SUMS.txt'), 'utf8'), `${checksum('synthetic installer')}  ${name}\n`);
});
