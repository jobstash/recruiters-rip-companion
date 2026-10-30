import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createUpdateController, compareVersions, validateAssetUrl, validateRelease, extractUpdateZip } from '../src/updates.mjs';

const REPO = 'https://github.com/jobstash/recruiters-rip-companion';
const API = 'https://api.github.com/repos/jobstash/recruiters-rip-companion/releases/latest';
const bytes = Buffer.from('synthetic downloaded update bytes');
const digest = value => createHash('sha256').update(value).digest('hex');
const assetName = version => `recruiters-rip-companion-${version}-mac-arm64.zip`;
function release(version = '1.3.0', content = bytes) {
  const tag = `v${version}`;
  return { tag_name: tag, draft: false, prerelease: false, published_at: '2026-10-01T00:00:00Z', html_url: `${REPO}/releases/tag/${tag}`,
    assets: [{ name: assetName(version), state: 'uploaded', size: content.length, digest: `sha256:${digest(content)}`,
      browser_download_url: `${REPO}/releases/download/${tag}/${assetName(version)}` }] };
}
function json(value, status = 200) { return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } }); }
async function fixture(t, options = {}) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'recruiters-updates-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const calls = [];
  const metadata = options.release ?? release();
  const controller = createUpdateController({ version: '1.2.3', platform: 'darwin', arch: 'arm64', directory: path.join(root, 'updates'),
    appPath: null, packaged: false, quit: () => { throw new Error('Source installation must not quit'); },
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      if (url === API) return json(metadata);
      return new Response(bytes, { headers: { 'content-length': String(bytes.length) } });
    }, ...options.controller });
  await controller.initialize();
  return { root, controller, calls, directory: path.join(root, 'updates') };
}

test('stable semantic versions compare numerically and reject malformed or prerelease versions', () => {
  assert.equal(compareVersions('10.0.0', '9.99.99'), 1);
  assert.equal(compareVersions('1.2.3', '1.2.3+build.1'), 0);
  assert.equal(compareVersions('1.2.2', '1.2.3'), -1);
  for (const value of ['01.2.3', '1.2', 'v1.2.3', '1.2.3-beta.1', '1.2.3/../../app', '9007199254740992.0.0']) {
    assert.throws(() => compareVersions(value, '1.2.3'), { code: 'INVALID_VERSION' });
  }
});

test('release validation requires stable published metadata and exact platform asset identity', () => {
  const valid = release();
  assert.equal(validateRelease(valid, { platform: 'darwin', arch: 'arm64' }).version, '1.3.0');
  assert.equal(validateRelease(release('1.3.0+build.1'), { platform: 'darwin', arch: 'arm64' }).version, '1.3.0+build.1');
  for (const mutate of [
    row => { row.draft = true; }, row => { row.prerelease = true; }, row => { row.published_at = null; },
    row => { row.tag_name = 'v01.3.0'; }, row => { row.tag_name = 'v1.3.0-beta'; },
    row => { row.assets = []; }, row => { row.assets.push({ ...row.assets[0] }); },
    row => { row.assets[0].name = 'recruiters-rip-companion-1.3.0-mac-x64.zip'; },
    row => { row.assets[0].size = 0; }, row => { row.assets[0].size = 1024 ** 3 + 1; },
    row => { row.assets[0].size = 1.5; }, row => { row.assets[0].state = 'new'; },
    row => { row.assets[0].digest = 'md5:untrusted'; }, row => { delete row.assets[0].digest; },
  ]) {
    const row = structuredClone(valid); mutate(row);
    assert.throws(() => validateRelease(row, { platform: 'darwin', arch: 'arm64' }));
  }
  assert.throws(() => validateRelease(valid, { platform: 'darwin', arch: 'x64' }), { code: 'UNSUPPORTED_PLATFORM' });
  assert.throws(() => validateRelease(valid, { platform: 'linux', arch: 'arm64' }), { code: 'UNSUPPORTED_PLATFORM' });
});

for (const [platform, suffix] of [['win32', 'win-x64.exe'], ['linux', 'linux-x64.AppImage']]) {
  function platformRelease() {
    const metadata = release();
    metadata.assets[0].name = `recruiters-rip-companion-1.3.0-${suffix}`;
    metadata.assets[0].browser_download_url = `${REPO}/releases/download/v1.3.0/${metadata.assets[0].name}`;
    return metadata;
  }
  test(`${platform} discovery selects the exact installer and rejects wrong architecture or OS`, () => {
    const metadata = platformRelease();
    assert.equal(validateRelease(metadata, { platform, arch: 'x64' }).asset.name, metadata.assets[0].name);
    assert.throws(() => validateRelease(metadata, { platform, arch: 'arm64' }), { code: 'UNSUPPORTED_PLATFORM' });
    assert.throws(() => validateRelease(release(), { platform, arch: 'x64' }), { code: 'INVALID_ASSET' });
    metadata.assets[0].name = metadata.assets[0].name.replace('x64', 'arm64');
    assert.throws(() => validateRelease(metadata, { platform, arch: 'x64' }), { code: 'INVALID_ASSET' });
  });
  test(`${platform} unsupported installation offers a verified manual file without quitting`, async t => {
    const metadata = platformRelease();
    delete metadata.assets[0].digest;
    const checksums = `${digest(bytes)}  ${metadata.assets[0].name}\n`;
    metadata.assets.push({ name: 'SHA256SUMS.txt', state: 'uploaded', size: Buffer.byteLength(checksums),
      browser_download_url: `${REPO}/releases/download/v1.3.0/SHA256SUMS.txt` });
    const { controller } = await fixture(t, { controller: { platform, arch: 'x64', packaged: true,
      quit: () => assert.fail('An unsupported installation must not quit'),
      fetchImpl: async url => url === API ? json(metadata) : new Response(url.endsWith('SHA256SUMS.txt') ? checksums : bytes) } });
    await controller.check(); await controller.download();
    const result = await controller.install();
    assert.equal(path.extname(result.manualPath), platform === 'win32' ? '.exe' : '.AppImage');
    assert.equal(digest(await readFile(result.manualPath)), digest(bytes));
    assert.equal(controller.state().status, 'manual-required');
    assert.equal(Boolean(result.reveal), platform === 'linux');
    assert.equal(controller.state().automaticSupported, false);
  });
  test(`${platform} does not hand off a modified installer`, async t => {
    const { controller, directory } = await fixture(t, { release: platformRelease(),
      controller: { platform, arch: 'x64' } });
    await controller.check(); await controller.download();
    const filename = (await readdir(directory)).find(name => name.startsWith('download-'));
    await writeFile(path.join(directory, filename), Buffer.from('x'.repeat(bytes.length)));
    await assert.rejects(controller.install(), { code: 'CHECKSUM_MISMATCH' });
  });
}

test('download addresses reject credentials, foreign repositories and arbitrary redirect hosts', () => {
  const asset = release().assets[0];
  const options = { tag: 'v1.3.0', name: asset.name };
  assert.equal(validateAssetUrl(asset.browser_download_url, options), asset.browser_download_url);
  assert.equal(validateAssetUrl('https://release-assets.githubusercontent.com/github-production-release-asset/asset?signature=synthetic', { ...options, redirect: true }).startsWith('https://release-assets.'), true);
  for (const url of [
    asset.browser_download_url.replace('https:', 'http:'), asset.browser_download_url.replace('github.com/', 'github.com.evil.test/'),
    asset.browser_download_url.replace('github.com/', 'secret@github.com/'), asset.browser_download_url.replace('jobstash/', 'foreign/'),
    `${asset.browser_download_url}?token=secret`, `${asset.browser_download_url}#fragment`, 'https://localhost/update.zip',
    'https://127.0.0.1/update.zip', 'https://release-assets.githubusercontent.com.evil.test/update.zip',
    'https://secret@release-assets.githubusercontent.com/update.zip', 'https://objects.githubusercontent.com:444/update.zip',
  ]) assert.throws(() => validateAssetUrl(url, { ...options, redirect: true }), { code: 'UNTRUSTED_URL' });
});

test('check is separate from download and reports a real newer or current stable release', async t => {
  const { controller, calls } = await fixture(t);
  assert.equal((await controller.check()).status, 'available');
  assert.equal(controller.state().latestVersion, '1.3.0');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, API);
  assert.equal(calls[0].init.credentials, 'omit');
  assert.equal(calls[0].init.redirect, 'manual');
  assert.equal(Object.keys(calls[0].init.headers).some(name => /authorization/i.test(name)), false);
  const current = await fixture(t, { release: release('1.2.3') });
  assert.equal((await current.controller.check()).status, 'current');
  await assert.rejects(current.controller.download(), { code: 'INVALID_STATE' });
});

test('404 means no public release, and invalid latest metadata never means current', async t => {
  const absent = await fixture(t, { controller: { fetchImpl: async () => new Response(null, { status: 404 }) } });
  assert.equal((await absent.controller.check()).status, 'no-release');
  assert.equal(absent.controller.state().latestVersion, null);
  assert.equal(absent.controller.state().error.code, 'NO_PUBLIC_RELEASE');
  const invalid = release('1.2.3'); invalid.assets = [];
  const broken = await fixture(t, { release: invalid });
  await assert.rejects(broken.controller.check(), { code: 'INVALID_ASSET' });
  assert.equal(broken.controller.state().status, 'error');
  assert.equal(broken.controller.state().latestVersion, null);
});

test('download verifies digest, publishes bounded progress and keeps all private paths out of state', async t => {
  const states = [];
  const { root, controller, directory } = await fixture(t, { controller: { onChange: state => states.push(state) } });
  await controller.check();
  await controller.download();
  assert.equal(controller.state().status, 'downloaded');
  const names = await readdir(directory);
  assert.equal(names.filter(name => name.endsWith('.zip')).length, 1);
  assert.equal(names.some(name => name.endsWith('.partial')), false);
  assert.deepEqual(states.find(state => state.progress?.received === bytes.length)?.progress, { received: bytes.length, total: bytes.length });
  assert.deepEqual(Object.keys(controller.state()).sort(), ['automaticReason', 'automaticSupported', 'error', 'latestVersion', 'progress', 'releaseUrl', 'status', 'version']);
  assert.equal(JSON.stringify(controller.state()).includes(root), false);
  const snapshot = controller.state(); snapshot.status = 'invented';
  assert.equal(controller.state().status, 'downloaded');
});

test('official checksum asset supplies a missing GitHub digest and rejects contradictory metadata', async t => {
  const metadata = release(); delete metadata.assets[0].digest;
  const checksum = `${digest(bytes)}  ${assetName('1.3.0')}\n`;
  metadata.assets.push({ name: 'SHA256SUMS.txt', state: 'uploaded', size: Buffer.byteLength(checksum), browser_download_url: `${REPO}/releases/download/v1.3.0/SHA256SUMS.txt` });
  const makeFetch = text => async url => url === API ? json(metadata) : new Response(url.endsWith('SHA256SUMS.txt') ? text : bytes);
  const valid = await fixture(t, { controller: { fetchImpl: makeFetch(checksum) } });
  await valid.controller.check(); await valid.controller.download();
  assert.equal(valid.controller.state().status, 'downloaded');
  const wrong = await fixture(t, { controller: { fetchImpl: makeFetch(checksum.replace(digest(bytes), '0'.repeat(64))) } });
  await wrong.controller.check();
  await assert.rejects(wrong.controller.download(), { code: 'CHECKSUM_MISMATCH' });
  assert.deepEqual(await readdir(wrong.directory), []);
  const duplicate = `${checksum}${checksum}`;
  metadata.assets[1].size = Buffer.byteLength(duplicate);
  const ambiguous = await fixture(t, { controller: { fetchImpl: makeFetch(duplicate) } });
  await ambiguous.controller.check();
  await assert.rejects(ambiguous.controller.download(), { code: 'INVALID_CHECKSUM' });
});

test('untrusted redirect is rejected before any request to its destination', async t => {
  const destinations = [];
  const { controller, directory } = await fixture(t, { controller: { fetchImpl: async url => {
    destinations.push(url);
    return url === API ? json(release()) : new Response(null, { status: 302, headers: { location: 'https://127.0.0.1/private' } });
  } } });
  await controller.check();
  await assert.rejects(controller.download(), { code: 'UNTRUSTED_URL' });
  assert.equal(destinations.length, 2);
  assert.deepEqual(await readdir(directory), []);
});

test('known GitHub asset redirect is explicitly followed without credential headers', async t => {
  const final = 'https://release-assets.githubusercontent.com/github-production-release-asset/synthetic?signature=public';
  const calls = [];
  const { controller } = await fixture(t, { controller: { fetchImpl: async (url, init) => {
    calls.push({ url, init });
    if (url === API) return json(release());
    return url === final ? new Response(bytes) : new Response(null, { status: 302, headers: { location: final } });
  } } });
  await controller.check(); await controller.download();
  assert.equal(calls.length, 3);
  assert.equal(calls[2].url, final);
  assert.deepEqual(calls[2].init.headers, { Accept: 'application/octet-stream' });
});

test('checksum, oversized and truncated downloads are rejected and deleted', async t => {
  for (const content of [Buffer.from('x'.repeat(bytes.length)), bytes.subarray(0, 3), Buffer.concat([bytes, Buffer.from('extra')])]) {
    const { controller, directory } = await fixture(t, { controller: { fetchImpl: async url => url === API ? json(release()) : new Response(content) } });
    await controller.check();
    await assert.rejects(controller.download(), error => ['CHECKSUM_MISMATCH', 'SIZE_MISMATCH'].includes(error.code));
    assert.deepEqual(await readdir(directory), []);
    assert.equal(controller.state().status, 'error');
  }
});

test('cancelling a partial stream removes it and single-flight prevents overlapping checks', async t => {
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  let cancelled = false;
  const { controller, directory } = await fixture(t, { controller: { fetchImpl: async url => {
    if (url === API) return json(release());
    return new Response(new ReadableStream({ start(stream) { stream.enqueue(bytes.subarray(0, 4)); started(); }, cancel() { cancelled = true; } }));
  } } });
  await controller.check();
  const pending = controller.download();
  const rejection = assert.rejects(pending, { code: 'CANCELLED' });
  await ready;
  await assert.rejects(controller.check(), { code: 'UPDATE_BUSY' });
  await controller.cancel();
  await rejection;
  assert.equal(cancelled, true);
  assert.equal(controller.state().status, 'cancelled');
  assert.deepEqual(await readdir(directory), []);
  await assert.rejects(controller.cancel(), { code: 'INVALID_STATE' });
});

test('a stalled release check times out cleanly without a retry', async t => {
  let requests = 0;
  const { controller } = await fixture(t, { controller: { fetchImpl: () => { requests++; return new Promise(() => {}); } } });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pending = controller.check();
  const rejection = assert.rejects(pending, { code: 'UPDATE_TIMEOUT' });
  t.mock.timers.tick(30000);
  await rejection;
  assert.equal(requests, 1);
  assert.equal(controller.state().status, 'error');
  assert.equal(controller.state().error.code, 'UPDATE_TIMEOUT');
});

test('unmanaged developer checkouts offer a manual installer without quitting', async t => {
  let quits = 0;
  const { controller } = await fixture(t, { controller: { quit: () => { quits++; } } });
  assert.equal(controller.state().automaticSupported, false);
  await assert.rejects(controller.install(), { code: 'INVALID_STATE' });
  await controller.check(); await controller.download();
  assert.ok((await controller.install()).manualPath);
  assert.equal(quits, 0);
  assert.equal(controller.state().status, 'manual-required');
});

test('ahead builds identify the latest published version and never downgrade', async t => {
  const { controller } = await fixture(t, { release: release('1.2.2') });
  assert.equal((await controller.check()).status, 'ahead');
  assert.equal(controller.state().latestVersion, '1.2.2');
  await assert.rejects(controller.download(), { code: 'INVALID_STATE' });
  assert.equal((await controller.check()).status, 'ahead');
});

test('checks preserve a verified pending download while waiting for idle', async t => {
  const { controller, calls, directory } = await fixture(t);
  await controller.check(); await controller.download();
  const names = await readdir(directory);
  assert.equal((await controller.check()).status, 'downloaded');
  assert.equal(calls.length, 2);
  assert.deepEqual(await readdir(directory), names);
});

test('unmanaged checkout downloads return a verified ZIP without modifying local files', async t => {
  const { root, controller } = await fixture(t);
  const checkout = path.join(root, 'synthetic-checkout');
  await mkdir(checkout);
  await writeFile(path.join(checkout, 'identity.txt'), 'synthetic-device-identity');
  await controller.check(); await controller.download();
  const result = await controller.install();
  assert.equal(controller.state().status, 'manual-required');
  assert.deepEqual(Object.keys(result), ['manualPath']);
  assert.equal(digest(await readFile(result.manualPath)), digest(bytes));
  assert.equal(await readFile(path.join(checkout, 'identity.txt'), 'utf8'), 'synthetic-device-identity');
  assert.equal(JSON.stringify(controller.state()).includes(root), false);
});

test('a changed saved ZIP is never handed to a manual or automatic installer', async t => {
  const { controller, directory } = await fixture(t);
  await controller.check(); await controller.download();
  const name = (await readdir(directory)).find(item => item.endsWith('.zip'));
  await writeFile(path.join(directory, name), Buffer.from('x'.repeat(bytes.length)));
  await assert.rejects(controller.install(), { code: 'CHECKSUM_MISMATCH' });
});

test('packaged install cannot target a linked app or an app other than the currently running bundle', async t => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'recruiters-targets-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const target = path.join(root, 'Synthetic.app');
  const linked = path.join(root, 'Linked.app');
  await mkdir(target); await symlink(target, linked, process.platform === 'win32' ? 'junction' : 'dir');
  for (const appPath of [target, linked]) {
    let quits = 0;
    const { controller } = await fixture(t, { controller: { appPath, packaged: true, quit: () => { quits++; } } });
    await controller.check(); await controller.download();
    assert.ok((await controller.install()).manualPath);
    assert.equal(controller.state().automaticSupported, false);
    assert.equal(quits, 0);
    assert.deepEqual(await readdir(target), []);
  }
});

test('filesystem errors in update storage are not exposed as public paths', async t => {
  const { controller, directory } = await fixture(t);
  await mkdir(path.join(directory, 'active.json'));
  // A controller initialized against malformed private state reports a concise
  // error, not the filesystem error or path in its UI snapshot.
  const other = createUpdateController({ version: '1.2.3', directory, appPath: null, packaged: false });
  await assert.rejects(other.initialize());
  assert.equal(JSON.stringify(other.state()).includes(directory), false);
  assert.equal(other.state().status, 'error');
  assert.equal(controller.state().status, 'idle');
});

test('explicit Check retries failed startup initialization after its private receipt is repaired', async t => {
  const { directory } = await fixture(t);
  const receipt = path.join(directory, 'active.json');
  await mkdir(receipt);
  let requests = 0;
  const controller = createUpdateController({ version: '1.2.3', platform: 'darwin', arch: 'arm64', directory,
    appPath: null, packaged: false, fetchImpl: async () => { requests++; return json(release()); } });
  await assert.rejects(controller.initialize(), { code: 'INVALID_RECEIPT' });
  await assert.rejects(controller.check(), { code: 'INVALID_RECEIPT' });
  assert.equal(requests, 0);
  assert.equal(controller.state().error.code, 'INVALID_RECEIPT');
  await rm(receipt, { recursive: true });
  assert.equal((await controller.check()).status, 'available');
  assert.equal(requests, 1);
});

test('explicit Check preserves an unresolved installation receipt instead of hiding it behind release results', async t => {
  const { directory, root } = await fixture(t);
  const id = 'b'.repeat(32), target = path.join(root, 'Synthetic.app');
  const staged = path.join(root, `.recruiters-update-${id}.app`);
  const work = path.join(directory, `install-${id}`);
  await mkdir(target); await mkdir(staged); await mkdir(work);
  const journal = { schema: 1, id, version: '1.3.0', pid: process.pid, target, staged,
    backup: path.join(root, `.recruiters-backup-${id}.app`), journal: path.join(work, 'journal.json'), status: 'staged' };
  await writeFile(journal.journal, JSON.stringify(journal), { mode: 0o600 });
  await writeFile(path.join(directory, 'active.json'), JSON.stringify({ id }), { mode: 0o600 });
  let requests = 0;
  const controller = createUpdateController({ version: '1.2.3', platform: 'darwin', arch: 'arm64', directory,
    appPath: target, packaged: true, fetchImpl: async () => { requests++; return json(release()); } });
  assert.equal((await controller.initialize()).status, 'manual-required');
  for (let attempt = 0; attempt < 2; attempt++) {
    assert.equal((await controller.check()).status, 'manual-required');
    assert.equal(controller.state().error.code, 'INTERRUPTED_UPDATE');
  }
  assert.equal(requests, 0);
  assert.equal(JSON.parse(await readFile(journal.journal, 'utf8')).status, 'staged');
  assert.deepEqual(await readdir(target), []);
});

function zip(entries) {
  const files = [], central = [];
  let offset = 0;
  for (const { name, content = '', mode = 0o100644 } of entries) {
    const filename = Buffer.from(name), data = Buffer.from(content);
    let crc = 0xffffffff;
    for (const byte of data) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
    crc = (crc ^ 0xffffffff) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x800, 6);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(filename.length, 26);
    files.push(local, filename, data);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0); entry.writeUInt16LE(0x0314, 4); entry.writeUInt16LE(20, 6); entry.writeUInt16LE(0x800, 8);
    entry.writeUInt32LE(crc, 16); entry.writeUInt32LE(data.length, 20); entry.writeUInt32LE(data.length, 24); entry.writeUInt16LE(filename.length, 28);
    entry.writeUInt32LE((mode * 65536) >>> 0, 38); entry.writeUInt32LE(offset, 42);
    central.push(entry, filename); offset += local.length + filename.length + data.length;
  }
  const index = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(index.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...files, index, end]);
}

test('ZIP extraction accepts bounded internal framework links and rejects traversal or escaping links', { skip: process.platform === 'win32' && 'macOS framework symlink extraction is not a Windows installation path' }, async t => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'recruiters-zip-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const app = 'Recruiters.rip Companion.app';
  const signal = new AbortController().signal;
  const valid = [
    { name: `${app}/Contents/Frameworks/Versions/A/binary`, content: 'synthetic executable', mode: 0o100755 },
    { name: `${app}/Contents/Frameworks/Versions/Current`, content: 'A', mode: 0o120777 },
  ];
  const archive = path.join(root, 'valid.zip'); await writeFile(archive, zip(valid));
  const bundle = await extractUpdateZip(archive, path.join(root, 'valid'), signal);
  assert.equal(await readFile(path.join(bundle, 'Contents/Frameworks/Versions/Current/binary'), 'utf8'), 'synthetic executable');
  const attacks = [
    [{ name: `${app}/../outside`, content: 'escape' }],
    [{ name: '/absolute/path', content: 'escape' }],
    [{ name: `${app}/Contents/link`, content: '../../../outside', mode: 0o120777 }],
    [{ name: `${app}/Contents/link`, content: '/tmp/outside', mode: 0o120777 }],
    [{ name: 'Different.app/Contents/file', content: 'wrong app' }],
    [{ name: `${app}/Contents/special`, mode: 0o020600 }],
    [{ name: `${app}/Contents/file`, content: 'a' }, { name: `${app}/Contents/FILE`, content: 'b' }],
  ];
  for (const [index, entries] of attacks.entries()) {
    const file = path.join(root, `attack-${index}.zip`); await writeFile(file, zip(entries));
    await assert.rejects(extractUpdateZip(file, path.join(root, `attack-${index}`), signal));
  }
  assert.equal((await readdir(root)).includes('outside'), false);
});

test('ZIP extraction writes app.asar as physical bytes alongside unpacked resources', async t => {
  const disk = createRequire(import.meta.url)(process.versions.electron ? 'original-fs' : 'node:fs').promises;
  const root = await disk.realpath(await disk.mkdtemp(path.join(tmpdir(), 'recruiters-physical-asar-')));
  t.after(() => disk.rm(root, { recursive: true, force: true }));
  const app = 'Recruiters.rip Companion.app';
  const bytes = 'Opaque synthetic archive bytes, not a mounted ASAR filesystem.';
  const archive = path.join(root, 'update.zip');
  await disk.writeFile(archive, zip([
    { name: `${app}/Contents/Resources/app.asar`, content: bytes },
    { name: `${app}/Contents/Resources/app.asar.unpacked/src/update-install.cjs`, content: 'synthetic unpacked helper' },
  ]));
  const bundle = await extractUpdateZip(archive, path.join(root, 'extract'), new AbortController().signal);
  const extracted = path.join(bundle, 'Contents/Resources/app.asar');
  assert.equal((await disk.lstat(extracted)).isFile(), true);
  assert.equal(await disk.readFile(extracted, 'utf8'), bytes);
  assert.equal(await disk.readFile(path.join(bundle, 'Contents/Resources/app.asar.unpacked/src/update-install.cjs'), 'utf8'), 'synthetic unpacked helper');
});
