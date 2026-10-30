// Invoked only by the main-source release job after every native gate succeeds.
// Never mutates an existing tag/release, including an interrupted draft.
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compareStable } from './release-policy.mjs';

const repository = 'jobstash/recruiters-rip-companion';
const api = `https://api.github.com/repos/${repository}`;
const root = fileURLToPath(new URL('..', import.meta.url));
const { version } = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
compareStable(version, version);
if (process.env.GITHUB_ACTIONS !== 'true' || process.env.GITHUB_REPOSITORY !== repository ||
    process.env.GITHUB_REF !== 'refs/heads/main' || !['push', 'workflow_dispatch'].includes(process.env.GITHUB_EVENT_NAME) ||
    !/^[a-f0-9]{40}$/.test(process.env.GITHUB_SHA || '') || !process.env.GH_TOKEN) throw new Error('Publication requires the official main-source GitHub Actions release job.');
if (process.argv.length !== 3) throw new Error('Usage: node scripts/publish-release.mjs <downloaded-artifacts-directory>');
const directory = path.resolve(process.argv[2]);
const nativeNames = ['mac-arm64.zip', 'mac-arm64.dmg', 'win-x64.exe', 'linux-x64.AppImage'].map(suffix => `recruiters-rip-companion-${version}-${suffix}`);
const browserNames = ['recruiters-rip-browser-production.zip', 'recruiters-rip-browser-firefox-production.zip'];
const sourceNames = ['install-source.sh', 'install-source.ps1', 'install-source.mjs'];
const required = [...nativeNames, ...browserNames, ...sourceNames];
const files = new Map(), manifests = [];
async function visit(folder) {
  for (const entry of await readdir(folder, { withFileTypes: true })) {
    const file = path.join(folder, entry.name);
    if (entry.isSymbolicLink()) throw new Error('Release artifacts may not contain symbolic links.');
    if (entry.isDirectory()) await visit(file);
    else if (entry.isFile() && required.includes(entry.name)) {
      if (files.has(entry.name)) throw new Error(`Duplicate release asset: ${entry.name}`);
      const info = await lstat(file);
      if (info.size < 1 || info.size > 1024 ** 3) throw new Error(`Invalid asset size: ${entry.name}`);
      const hash = createHash('sha256');
      for await (const chunk of createReadStream(file)) hash.update(chunk);
      files.set(entry.name, { file, size: info.size, digest: hash.digest('hex') });
    } else if (entry.name === 'SHA256SUMS.txt') manifests.push(await readFile(file, 'utf8'));
  }
}
await visit(directory);
for (const name of required) if (!files.has(name)) throw new Error(`Missing required native-gated release asset: ${name}`);
for (const name of sourceNames) {
  const expected = createHash('sha256').update(await readFile(path.join(root, 'scripts', name))).digest('hex');
  if (files.get(name).digest !== expected) throw new Error(`Source bootstrap does not match the gated commit: ${name}`);
}
for (const name of nativeNames) {
  const matches = manifests.flatMap(text => text.split(/\r?\n/)).map(line => /^([a-f0-9]{64})  (.+)$/.exec(line)).filter(match => match?.[2] === name);
  if (matches.length !== 1 || matches[0][1] !== files.get(name).digest) throw new Error(`Missing, duplicate, or mismatching native checksum: ${name}`);
}
const checksumFile = path.join(directory, 'SHA256SUMS.txt');
await writeFile(checksumFile, required.map(name => `${files.get(name).digest}  ${name}\n`).join(''), { flag: 'wx' });
const checksumBytes = await readFile(checksumFile);
files.set('SHA256SUMS.txt', { file: checksumFile, size: checksumBytes.length, digest: createHash('sha256').update(checksumBytes).digest('hex') });
const headers = { Authorization: `Bearer ${process.env.GH_TOKEN}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
async function request(url, options = {}, missing = false) {
  const response = await fetch(url, { ...options, headers: { ...headers, ...options.headers }, signal: AbortSignal.timeout(15 * 60 * 1000) });
  if (missing && response.status === 404) { await response.body?.cancel(); return null; }
  if (!response.ok) { await response.body?.cancel(); throw new Error(`GitHub release request failed (${response.status}); an incomplete draft, if created, remains unpublished.`); }
  return response.status === 204 ? null : response.json();
}
const tag = `v${version}`;
const currentMain = await request(`${api}/commits/main`);
if (currentMain.sha !== process.env.GITHUB_SHA) throw new Error('This run is no longer the current main commit; refusing stale publication.');
if (await request(`${api}/releases/tags/${tag}`, {}, true)) throw new Error(`Release ${tag} already exists. Public releases and interrupted drafts are never overwritten.`);
if (await request(`${api}/git/ref/tags/${tag}`, {}, true)) throw new Error(`Tag ${tag} already exists; refusing to publish under an unverified tag.`);
const latest = await request(`${api}/releases/latest`, {}, true);
if (latest && compareStable(version, latest.tag_name.replace(/^v/, '')) <= 0) throw new Error('Publication version must be newer than the latest stable release.');
const body = `Built from ${process.env.GITHUB_SHA}. All three native binary packaging/startup/update gates and all three native source bootstrap/build/update gates passed in https://github.com/${repository}/actions/runs/${process.env.GITHUB_RUN_ID}.\n\nMac Apple silicon: ad-hoc signed, not notarized. Windows x64: unsigned NSIS installer. Linux x64: AppImage, graphical desktop and FUSE required. Chrome ZIP: unpacked extension source. Firefox ZIP: unsigned temporary-load source archive, not a signed XPI. Source installers: install-source.sh (Mac/Linux), install-source.ps1 (Windows), and their checksum-verified standalone install-source.mjs; Git and Node.js 24/npm are required. Managed source installs build the exact stable release with locked dependencies and retain the previous source version.\n\nSHA256SUMS.txt covers every download. Native update gates use the current updater and a pinned disposable binary solely as a physical replacement fixture, exercising actual verification, replacement, restart and app-written confirmation. This is not an old-version compatibility guarantee. Source gates use explicit clean local-candidate commits before publication while retaining actual clone, dependency installation, build, native restart and app-written confirmation. Both current update modes exercise the real scheduler with synthetic idle inputs, including refused final admission before successful handoff. See the native smoke reports for the exact exercised scenarios.\n\nSetup: https://recruiters.rip/docs`;
const release = await request(`${api}/releases`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tag_name: tag, target_commitish: process.env.GITHUB_SHA, name: `Recruiters.rip Companion ${version}`, body, draft: true, prerelease: false }) });
for (const [name, asset] of files) {
  const url = new URL(release.upload_url.replace(/\{.*$/, ''));
  if (url.protocol !== 'https:' || url.hostname !== 'uploads.github.com') throw new Error('GitHub returned an unexpected upload host.');
  url.searchParams.set('name', name);
  if (name === browserNames[1]) url.searchParams.set('label', 'Firefox unsigned temporary-load source archive (not a signed XPI)');
  const uploaded = await request(url, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(asset.size) }, body: createReadStream(asset.file), duplex: 'half' });
  if (uploaded.name !== name || uploaded.state !== 'uploaded' || uploaded.size !== asset.size || uploaded.digest !== `sha256:${asset.digest}`) throw new Error(`Uploaded asset verification failed: ${name}; draft remains unpublished.`);
}
const ready = await request(`${api}/releases/${release.id}`);
if (!ready.draft || ready.tag_name !== tag || ready.assets.length !== files.size) throw new Error('Draft asset inventory is incomplete or changed.');
for (const [name, asset] of files) {
  const matches = ready.assets.filter(item => item.name === name);
  if (matches.length !== 1 || matches[0].state !== 'uploaded' || matches[0].size !== asset.size || matches[0].digest !== `sha256:${asset.digest}`) throw new Error(`Final draft verification failed: ${name}`);
}
if ((await request(`${api}/commits/main`)).sha !== process.env.GITHUB_SHA) throw new Error('Main advanced during upload; draft remains unpublished.');
await request(`${api}/releases/${release.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ draft: false, make_latest: 'true' }) });
console.log(`Published ${tag} only after all ${files.size} assets and their SHA-256 metadata were verified.`);
