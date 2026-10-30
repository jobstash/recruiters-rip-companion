import { createHash, randomBytes } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import { access, chmod, copyFile, lstat, mkdir, open, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { spawn, execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yauzl from 'yauzl';

const require = createRequire(import.meta.url);
const installer = require('./update-install.cjs');
const { protectPrivatePath } = require('./platform-runtime.cjs');
const REPOSITORY = 'https://github.com/jobstash/recruiters-rip-companion';
const API = 'https://api.github.com/repos/jobstash/recruiters-rip-companion/releases/latest';
const PRODUCT = 'Recruiters.rip Companion.app';
const APP_ID = 'rip.recruiters.companion';
const MAX_ASSET = 1024 * 1024 * 1024;
const MAX_EXPANDED = 3 * MAX_ASSET;
const MAX_CHECKSUMS = 128 * 1024;
const MAX_RELEASE = 1024 * 1024;
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const DIGEST = /^sha256:([a-fA-F0-9]{64})$/;
const ASSET_HOSTS = new Set(['release-assets.githubusercontent.com', 'objects.githubusercontent.com']);
const CHECK_STATES = ['idle', 'available', 'current', 'no-release', 'downloaded', 'error', 'cancelled', 'manual-required', 'launched', 'confirmed', 'rolled-back'];

function fail(code, message) { return Object.assign(new Error(message), { code, publicUpdateError: true }); }
function versionParts(version) {
  const match = typeof version === 'string' && SEMVER.exec(version);
  if (!match || match.slice(1, 4).some(part => !Number.isSafeInteger(Number(part)))) throw fail('INVALID_VERSION', 'The release version is not a valid stable semantic version.');
  return match.slice(1, 4).map(Number);
}
export function compareVersions(a, b) {
  const left = versionParts(a), right = versionParts(b);
  for (let i = 0; i < left.length; i++) if (left[i] !== right[i]) return left[i] < right[i] ? -1 : 1;
  return 0;
}

function secureUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw fail('UNTRUSTED_URL', 'The release contains an invalid download address.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.hash) throw fail('UNTRUSTED_URL', 'The release download address is not an approved HTTPS address.');
  return url;
}
function decodedPath(url) {
  try { return decodeURIComponent(url.pathname); }
  catch { throw fail('UNTRUSTED_URL', 'The release contains an invalid encoded address.'); }
}

export function validateAssetUrl(value, { tag, name, redirect = false } = {}) {
  const url = secureUrl(value);
  if (url.hostname === 'github.com') {
    const expected = `/jobstash/recruiters-rip-companion/releases/download/${tag}/${name}`;
    if (decodedPath(url) !== expected || url.search) throw fail('UNTRUSTED_URL', 'The download does not belong to the official companion release.');
  } else if (!redirect || !ASSET_HOSTS.has(url.hostname)) throw fail('UNTRUSTED_URL', 'The download redirected outside GitHub release hosting.');
  return url.href;
}

function validateAsset(asset, tag, expectedName, maxSize) {
  if (!asset || asset.name !== expectedName || !Number.isSafeInteger(asset.size) || asset.size < 1 || asset.size > maxSize || asset.state !== 'uploaded') {
    throw fail('INVALID_ASSET', 'The public release does not have a complete, supported update asset.');
  }
  const url = validateAssetUrl(asset.browser_download_url, { tag, name: expectedName });
  let digest = null;
  if (asset.digest != null) {
    const match = typeof asset.digest === 'string' && DIGEST.exec(asset.digest);
    if (!match) throw fail('INVALID_CHECKSUM', 'The release asset has an invalid SHA-256 digest.');
    digest = match[1].toLowerCase();
  }
  return { name: expectedName, size: asset.size, url, digest };
}

export function validateRelease(release, { platform, arch }) {
  const target = platform === 'darwin' && arch === 'arm64' ? 'mac-arm64.zip'
    : platform === 'win32' && arch === 'x64' ? 'win-x64.exe'
      : platform === 'linux' && arch === 'x64' ? 'linux-x64.AppImage' : null;
  if (!target) throw fail('UNSUPPORTED_PLATFORM', 'Updates support macOS Apple silicon, Windows x64 and Linux x64. Download an installer compatible with your computer.');
  if (!release || release.draft !== false || release.prerelease !== false || !release.published_at || !Number.isFinite(Date.parse(release.published_at))) {
    throw fail('INVALID_RELEASE', 'The repository has no valid published stable release.');
  }
  const tag = release.tag_name;
  if (typeof tag !== 'string') throw fail('INVALID_RELEASE', 'The published release has no valid version tag.');
  const version = tag.startsWith('v') ? tag.slice(1) : tag;
  versionParts(version);
  const releaseUrl = `${REPOSITORY}/releases/tag/${encodeURIComponent(tag)}`;
  const page = secureUrl(release.html_url);
  if (page.hostname !== 'github.com' || decodedPath(page) !== `/jobstash/recruiters-rip-companion/releases/tag/${tag}` || page.search) throw fail('UNTRUSTED_URL', 'The release page does not belong to the official companion repository.');
  const name = `recruiters-rip-companion-${version}-${target}`;
  if (!Array.isArray(release.assets)) throw fail('INVALID_ASSET', 'The public release is missing its compatible installer.');
  const matching = release.assets.filter(asset => asset?.name === name);
  if (matching.length !== 1) throw fail('INVALID_ASSET', 'The public release is missing a unique installer for this operating system and architecture.');
  const asset = validateAsset(matching[0], tag, name, MAX_ASSET);
  let checksums = null;
  if (!asset.digest) {
    const matches = release.assets.filter(item => item?.name === 'SHA256SUMS.txt');
    if (matches.length !== 1) throw fail('MISSING_CHECKSUM', 'This release has no SHA-256 digest or SHA256SUMS.txt. Choose a release with checksum metadata.');
    checksums = validateAsset(matches[0], tag, 'SHA256SUMS.txt', MAX_CHECKSUMS);
  }
  return { version, tag, releaseUrl, asset, checksums };
}

function throwIfAborted(signal) { if (signal.aborted) throw signal.reason ?? fail('CANCELLED', 'The update was cancelled.'); }
function abortable(promise, signal) {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason ?? fail('CANCELLED', 'The update was cancelled.'));
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

async function request(fetchImpl, url, { signal, asset = null } = {}) {
  let current = url;
  for (let redirects = 0; redirects <= 5; redirects++) {
    throwIfAborted(signal);
    const pendingResponse = Promise.resolve(fetchImpl(current, {
      redirect: 'manual', signal,
      headers: asset ? { Accept: 'application/octet-stream' } : { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
      credentials: 'omit', referrerPolicy: 'no-referrer',
    }));
    // Also dispose a response that arrives after cancellation from a fetch
    // adapter which did not itself honour the AbortSignal.
    void pendingResponse.then(response => signal.aborted ? response.body?.cancel() : undefined, () => {}).catch(() => {});
    const response = await abortable(pendingResponse, signal);
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      await response.body?.cancel();
      if (!asset || !location || redirects === 5) throw fail('UNTRUSTED_REDIRECT', 'The release request returned an unsupported redirect.');
      current = validateAssetUrl(new URL(location, current).href, { ...asset, redirect: true });
      continue;
    }
    // fetchImpl must not silently follow redirects (including custom adapters).
    if (response.redirected || (response.url && response.url !== current)) {
      await response.body?.cancel();
      throw fail('UNTRUSTED_REDIRECT', 'The release request followed an unchecked redirect.');
    }
    return response;
  }
  throw fail('UNTRUSTED_REDIRECT', 'The release download redirected too many times.');
}

async function streamBytes(response, { maximum, expected = null, signal, chunk }) {
  if (!response.ok || !response.body) throw fail('DOWNLOAD_FAILED', 'The release could not be downloaded. Check the connection and try again.');
  const length = response.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > maximum || (expected !== null && Number(length) !== expected))) {
    await response.body.cancel();
    throw fail('SIZE_MISMATCH', 'The downloaded size does not match the release metadata.');
  }
  const reader = response.body.getReader();
  let received = 0;
  try {
    for (;;) {
      const result = await abortable(reader.read(), signal);
      if (result.done) break;
      received += result.value.byteLength;
      if (received > maximum || (expected !== null && received > expected)) throw fail('SIZE_MISMATCH', 'The download exceeded its declared size.');
      await chunk(result.value, received);
      throwIfAborted(signal);
    }
    if (expected !== null && received !== expected) throw fail('SIZE_MISMATCH', 'The download ended before the declared size was received.');
    return received;
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

async function boundedText(response, maximum, signal, expected = null) {
  const chunks = [];
  await streamBytes(response, { maximum, expected, signal, chunk: async bytes => { chunks.push(Buffer.from(bytes)); } });
  return Buffer.concat(chunks).toString('utf8');
}

async function digestFile(file, signal) {
  const hash = createHash('sha256');
  const stream = createReadStream(file, { signal });
  for await (const bytes of stream) hash.update(bytes);
  return hash.digest('hex');
}

async function privateDirectory(directory) {
  if (!path.isAbsolute(directory)) throw fail('INVALID_DIRECTORY', 'The private update directory must be an absolute path.');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || await realpath(directory) !== path.resolve(directory) ||
      (process.getuid && info.uid !== process.getuid())) throw fail('INVALID_DIRECTORY', 'The update directory must be a private directory owned by the current user.');
  protectPrivatePath(directory, { directory: true });
}

function archivePath(name) {
  const trimmed = name.endsWith('/') ? name.slice(0, -1) : name;
  const parts = trimmed.split('/');
  if (!trimmed || name.length > 2048 || /[\\:\x00-\x1f\x7f]/.test(name) || parts.some(part => !part || part === '.' || part === '..') || name.startsWith('/')) {
    throw fail('UNSAFE_ARCHIVE', 'The update ZIP contains an unsafe path.');
  }
  return parts;
}

// Extract regular files before creating any symlinks. Electron framework links
// are allowed only when their eventual real target stays inside this bundle.
export async function extractUpdateZip(file, destination, signal) {
  await mkdir(destination, { mode: 0o700 });
  const zip = await new Promise((resolve, reject) => yauzl.open(file, { lazyEntries: true, autoClose: false, decodeStrings: true, strictFileNames: true, validateEntrySizes: true }, (error, result) => error ? reject(error) : resolve(result)));
  const seen = new Set(), links = [];
  let entries = 0, expanded = 0, inputStream = null, entryWork = Promise.resolve();
  const abort = () => { inputStream?.destroy(); zip.close(); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    await new Promise((resolve, reject) => {
      zip.once('error', reject);
      zip.once('end', resolve);
      zip.once('close', () => { if (signal.aborted) reject(signal.reason); });
      zip.on('entry', entry => {
        entryWork = (async () => {
          throwIfAborted(signal);
          const parts = archivePath(entry.fileName);
          if (++entries > 30000 || !Number.isSafeInteger(entry.uncompressedSize) || (expanded += entry.uncompressedSize) > MAX_EXPANDED) throw fail('UNSAFE_ARCHIVE', 'The update ZIP exceeds the extraction limit.');
          if (parts[0] === '__MACOSX') { zip.readEntry(); return; }
          if (parts[0] !== PRODUCT || (entry.generalPurposeBitFlag & 1)) throw fail('UNSAFE_ARCHIVE', 'The ZIP does not contain only the expected companion app.');
          const key = parts.join('/').normalize('NFC').toLowerCase();
          if (seen.has(key)) throw fail('UNSAFE_ARCHIVE', 'The ZIP contains conflicting app paths.');
          seen.add(key);
          const kind = (entry.externalFileAttributes >>> 16) & 0xf000;
          const isDirectory = entry.fileName.endsWith('/');
          if (![0, 0x8000, 0x4000, 0xa000].includes(kind) || (kind === 0x4000 && !isDirectory) || (isDirectory && ![0, 0x4000].includes(kind))) throw fail('UNSAFE_ARCHIVE', 'The ZIP contains an unsupported file type.');
          const output = path.join(destination, ...parts);
          if (isDirectory) await mkdir(output, { recursive: true, mode: 0o755 });
          else {
            await mkdir(path.dirname(output), { recursive: true, mode: 0o755 });
            const input = await new Promise((res, rej) => zip.openReadStream(entry, (error, stream) => error ? rej(error) : res(stream)));
            inputStream = input;
            if (kind === 0xa000) {
              if (entry.uncompressedSize > 2048) throw fail('UNSAFE_ARCHIVE', 'The ZIP contains an invalid symbolic link.');
              const chunks = [];
              for await (const chunk of input) { throwIfAborted(signal); chunks.push(chunk); }
              const target = Buffer.concat(chunks).toString('utf8');
              if (!target || path.posix.isAbsolute(target) || /[\\:\x00-\x1f\x7f]/.test(target)) throw fail('UNSAFE_ARCHIVE', 'The ZIP contains an unsafe symbolic link.');
              const resolved = path.posix.resolve('/', ...parts.slice(0, -1), target);
              if (!resolved.startsWith(`/${PRODUCT}/`)) throw fail('UNSAFE_ARCHIVE', 'A ZIP symbolic link escapes the app.');
              links.push({ output, target });
            } else {
              const handle = await open(output, 'wx', ((entry.externalFileAttributes >>> 16) & 0o111) ? 0o755 : 0o644);
              try {
                let written = 0;
                for await (const chunk of input) {
                  throwIfAborted(signal);
                  written += chunk.length;
                  if (written > entry.uncompressedSize) throw fail('UNSAFE_ARCHIVE', 'An extracted file exceeds its declared size.');
                  await handle.writeFile(chunk);
                }
                if (written !== entry.uncompressedSize) throw fail('UNSAFE_ARCHIVE', 'An extracted file is incomplete.');
              } finally { await handle.close(); }
            }
          }
          inputStream = null;
          zip.readEntry();
        })();
        entryWork.catch(reject);
      });
      zip.readEntry();
    });
    throwIfAborted(signal);
    for (const link of links) { throwIfAborted(signal); await symlink(link.target, link.output); }
    const bundle = path.join(destination, PRODUCT);
    for (const link of links) {
      throwIfAborted(signal);
      if (!(await realpath(link.output)).startsWith(`${bundle}${path.sep}`)) throw fail('UNSAFE_ARCHIVE', 'An extracted symbolic link escapes the app.');
    }
    if (!(await lstat(bundle)).isDirectory()) throw fail('INVALID_BUNDLE', 'The update ZIP contains no companion app.');
    return bundle;
  } finally {
    signal.removeEventListener('abort', abort);
    inputStream?.destroy();
    zip.close();
    await entryWork.catch(() => {});
  }
}

function system(binary, args, signal) {
  return new Promise((resolve, reject) => {
    execFile(binary, args, { signal, timeout: 90000, maxBuffer: 128 * 1024, env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', TMPDIR: '/tmp' } }, (error, stdout) => {
      if (error) reject(fail('BUNDLE_VALIDATION_FAILED', 'macOS could not validate the update app. Keep the existing app and use a compatible release.'));
      else resolve(stdout.trim());
    });
  });
}

async function validateBundle(bundle, version, signal, { signature = true } = {}) {
  const info = path.join(bundle, 'Contents', 'Info.plist');
  const plist = key => system('/usr/bin/plutil', ['-extract', key, 'raw', '-o', '-', info], signal);
  if (await plist('CFBundleIdentifier') !== APP_ID || await plist('CFBundleShortVersionString') !== version) throw fail('INVALID_BUNDLE', 'The app identifier or version does not match this companion release.');
  const executable = await plist('CFBundleExecutable');
  if (!executable || executable === '.' || executable === '..' || /[\/\\:\x00-\x1f]/.test(executable)) throw fail('INVALID_BUNDLE', 'The update app has an invalid executable.');
  const binary = path.join(bundle, 'Contents', 'MacOS', executable);
  if (!(await lstat(binary)).isFile() || !(await realpath(binary)).startsWith(`${bundle}${path.sep}`)) throw fail('INVALID_BUNDLE', 'The update app executable is missing or unsafe.');
  await system('/usr/bin/lipo', ['-verify_arch', 'arm64', binary], signal);
  if (signature) await system('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle], signal);
  // A valid ad-hoc signature is allowed. This does not assert Apple notarization.
  return binary;
}

async function launchHelper(helper, journal, executable, signal) {
  const child = spawn(executable, [helper, journal.journal], { detached: true, env: installer.minimalEnvironment(), stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  try {
    await abortable(new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', () => reject(fail('HELPER_FAILED', 'The update helper exited before handover. The existing app was not replaced.')));
      child.once('message', message => message?.type === 'ready' ? resolve() : reject(fail('HELPER_FAILED', 'The update helper could not prepare the replacement.')));
    }), signal);
    throwIfAborted(signal);
    await abortable(new Promise((resolve, reject) => child.send({ type: 'commit' }, error => error ? reject(error) : resolve())), signal);
    child.unref();
    child.channel?.unref();
    return child;
  } catch (error) { child.kill(); throw error; }
}

export function createUpdateController({ version, platform = process.platform, arch = process.arch, directory, appPath, packaged, pid = process.pid, authorize, quit, fetchImpl = globalThis.fetch, onChange = () => {} }) {
  versionParts(version);
  if (typeof directory !== 'string' || !path.isAbsolute(directory)) throw fail('INVALID_DIRECTORY', 'A private absolute update directory is required.');
  let view = { version, latestVersion: null, status: 'idle', progress: null, releaseUrl: null, error: null };
  let active = null, initialized = false, release = null, downloaded = null, handover = false;
  const activeFile = path.join(directory, 'active.json');
  const state = () => structuredClone(view);
  const update = changes => { view = { ...view, ...changes }; try { onChange(state()); } catch { /* UI callbacks cannot invalidate a download or install. */ } return state(); };
  const publicError = error => ({ code: error?.publicUpdateError ? error.code : 'UPDATE_FAILED', message: error?.publicUpdateError ? error.message : 'The update could not be completed. Check the connection or use the release page, then try again.' });

  function operate(name, allowed, timeout, work) {
    if (active) return Promise.reject(fail('UPDATE_BUSY', 'Another update operation is still running.'));
    if (handover || !allowed.includes(view.status)) return Promise.reject(fail('INVALID_STATE', `Cannot ${name} in the current update state.`));
    const controller = new AbortController();
    const operation = { name, controller, promise: null };
    active = operation;
    const timer = setTimeout(() => controller.abort(fail('UPDATE_TIMEOUT', 'The update operation timed out. Try again when the connection or app is ready.')), timeout);
    operation.promise = (async () => {
      try { return await work(controller.signal); }
      catch (error) {
        const reason = controller.signal.aborted ? controller.signal.reason : error;
        update({ status: reason?.code === 'CANCELLED' ? 'cancelled' : 'error', progress: null, error: publicError(reason) });
        throw reason;
      } finally { clearTimeout(timer); if (active === operation) active = null; }
    })();
    return operation.promise;
  }

  async function readActive() {
    let data;
    try {
      const info = await lstat(activeFile);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 256) throw fail('INVALID_RECEIPT', 'The update receipt is invalid. The existing app was not changed.');
      data = JSON.parse(await readFile(activeFile, 'utf8'));
    } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    if (!data || !/^[a-f0-9]{32}$/.test(data.id)) throw fail('INVALID_RECEIPT', 'The update receipt is invalid. The existing app was not changed.');
    return installer.readJournal(path.join(directory, `install-${data.id}`, 'journal.json'));
  }

  function requireInitialized() { if (!initialized) throw fail('NOT_INITIALIZED', 'Initialize updates before checking or installing.'); }

  function initialize() {
    return operate('initialize updates', ['idle', 'error', 'manual-required', 'launched'], 120000, async signal => {
      initialized = false;
      await privateDirectory(directory);
      const journal = await readActive();
      if (journal) {
        if (!packaged || !appPath || path.resolve(appPath) !== journal.target) throw fail('INVALID_RECEIPT', 'This update receipt belongs to a different installation. No app was changed.');
        await installer.validatePaths(journal, { recovery: true });
        update({ latestVersion: journal.version, releaseUrl: `${REPOSITORY}/releases` });
        if (version === journal.version && ['launching', 'launched', 'unconfirmed', 'confirmed'].includes(journal.status)) {
          if (!(await realpath(process.execPath)).startsWith(`${journal.target}${path.sep}`)) throw fail('INVALID_TARGET', 'Only startup from the updated installed app can confirm its installation.');
          await validateBundle(journal.target, version, signal);
          await installer.confirmUpdate(journal);
          // Only a startup of the exact staged version retires its old backup.
          await rm(journal.backup, { recursive: true, force: true });
          await rm(journal.staged, { recursive: true, force: true });
          update({ status: 'confirmed' });
        } else if (journal.status === 'rolled-back') {
          update({ status: 'rolled-back', error: { code: 'ROLLED_BACK', message: 'The previous app was restored because the update could not be installed or launched. Check the release page before trying again.' } });
        } else if (['swapping', 'launching'].includes(journal.status)) {
          // A helper crash between renames can leave the original name absent.
          // Recovery never replaces a running target; restore only if missing.
          let targetExists = true;
          try { await lstat(journal.target); } catch (error) { if (error.code === 'ENOENT') targetExists = false; else throw error; }
          if (!targetExists) {
            await rename(journal.backup, journal.target);
            await installer.writeJournal(journal, 'rolled-back');
            update({ status: 'rolled-back', error: { code: 'ROLLED_BACK', message: 'An interrupted update was rolled back. Your saved data was not changed.' } });
          } else update({ status: 'manual-required', error: { code: 'UNCONFIRMED_UPDATE', message: 'A previous update did not confirm startup. The previous app is retained. Quit the companion and reinstall from the release page if this persists.' } });
        } else if (['launched', 'unconfirmed'].includes(journal.status)) update({ status: 'launched', error: { code: 'UNCONFIRMED_UPDATE', message: 'The update was launched but its new version has not confirmed startup. The previous app is retained.' } });
        else update({ status: 'manual-required', error: { code: 'INTERRUPTED_UPDATE', message: 'A previous update did not finish. The existing app is unchanged. Check for updates again or use the release page.' } });
      } else {
        update({ status: 'idle', latestVersion: null, releaseUrl: null, error: null });
      }
      initialized = !['manual-required', 'launched'].includes(view.status);
      return state();
    });
  }

  async function check() {
    // A failed startup initialization is recoverable from the explicit Check
    // action. Complete it before taking the check's single-flight slot.
    if (!initialized) {
      await initialize();
      if (!initialized) return state();
    }
    return operate('check for updates', CHECK_STATES, 30000, async signal => {
      requireInitialized();
      update({ status: 'checking', progress: null, error: null, latestVersion: null, releaseUrl: `${REPOSITORY}/releases` });
      release = null;
      if (downloaded) { await rm(downloaded.file, { force: true }); downloaded = null; }
      const response = await request(fetchImpl, API, { signal });
      if (response.status === 404) {
        await response.body?.cancel();
        return update({ status: 'no-release', error: { code: 'NO_PUBLIC_RELEASE', message: 'No public release is available in the companion repository yet.' } });
      }
      if (!response.ok) { await response.body?.cancel(); throw fail('CHECK_FAILED', 'GitHub could not provide the latest public release. Check the connection or release page and try again.'); }
      let metadata;
      try { metadata = JSON.parse(await boundedText(response, MAX_RELEASE, signal)); }
      catch (error) { if (signal.aborted || error.code) throw error; throw fail('INVALID_RELEASE', 'GitHub returned malformed release metadata.'); }
      release = validateRelease(metadata, { platform, arch });
      return update({ latestVersion: release.version, releaseUrl: release.releaseUrl, status: compareVersions(release.version, version) > 0 ? 'available' : 'current' });
    });
  }

  function download() {
    return operate('download an update', ['available', 'cancelled', 'error', 'manual-required'], 15 * 60 * 1000, async signal => {
      requireInitialized();
      if (!release || compareVersions(release.version, version) <= 0) throw fail('INVALID_STATE', 'Check for a newer supported release before downloading.');
      update({ status: 'downloading', progress: { received: 0, total: release.asset.size }, error: null });
      const id = randomBytes(16).toString('hex');
      const partial = path.join(directory, `download-${id}.partial`);
      const file = path.join(directory, `download-${id}${path.extname(release.asset.name)}`);
      let handle;
      try {
        let expected = release.asset.digest;
        if (!expected) {
          const response = await request(fetchImpl, release.checksums.url, { signal, asset: { tag: release.tag, name: release.checksums.name } });
          const text = await boundedText(response, MAX_CHECKSUMS, signal, release.checksums.size);
          if (release.checksums.digest && createHash('sha256').update(text).digest('hex') !== release.checksums.digest) throw fail('CHECKSUM_MISMATCH', 'The release checksum file did not match GitHub metadata.');
          const matches = text.split(/\r?\n/).map(line => /^([a-fA-F0-9]{64}) [ *](.+)$/.exec(line)).filter(match => match?.[2] === release.asset.name);
          if (matches.length !== 1) throw fail('INVALID_CHECKSUM', 'The release checksum file has no unique SHA-256 entry for this update.');
          expected = matches[0][1].toLowerCase();
        }
        const response = await request(fetchImpl, release.asset.url, { signal, asset: { tag: release.tag, name: release.asset.name } });
        const hash = createHash('sha256');
        handle = await open(partial, 'wx', 0o600);
        await streamBytes(response, { maximum: MAX_ASSET, expected: release.asset.size, signal, chunk: async (bytes, received) => {
          hash.update(bytes);
          await handle.writeFile(bytes);
          update({ progress: { received, total: release.asset.size } });
        } });
        if (hash.digest('hex') !== expected) throw fail('CHECKSUM_MISMATCH', 'The downloaded update failed its SHA-256 checksum. It was deleted; check the release and try again.');
        await handle.sync();
        await handle.close(); handle = null;
        throwIfAborted(signal);
        await rename(partial, file);
        if (downloaded) await rm(downloaded.file, { force: true });
        downloaded = { file, digest: expected, version: release.version };
        return update({ status: 'downloaded', progress: null });
      } catch (error) {
        if (handle) await handle.close().catch(() => {});
        await rm(partial, { force: true });
        await rm(file, { force: true });
        throw error;
      }
    });
  }

  function install() {
    return operate('install an update', ['downloaded', 'manual-required'], 6 * 60 * 1000, async signal => {
      requireInitialized();
      if (!downloaded || !release || downloaded.version !== release.version) throw fail('INVALID_STATE', 'Download and verify an update before installing.');
      const info = await lstat(downloaded.file);
      if (!info.isFile() || info.isSymbolicLink() || info.size !== release.asset.size || await digestFile(downloaded.file, signal) !== downloaded.digest) throw fail('CHECKSUM_MISMATCH', 'The saved update no longer matches its checksum. Download it again before installing.');
      if (typeof authorize !== 'function') throw fail('APPROVAL_REQUIRED', 'Installing an update requires explicit approval in the companion.');
      const replaceable = platform === 'darwin' && arch === 'arm64' && packaged && appPath;
      update({ status: 'awaiting-approval', error: null });
      const approved = await abortable(authorize({ action: 'install-update', version, latestVersion: release.version,
        message: replaceable
          ? `Replace ${appPath}\nVersion ${version} → ${release.version}\n\nThe companion will close and reopen.`
          : platform === 'win32'
            ? `Open the verified Recruiters.rip Companion ${release.version} Windows installer?\nFinish installation in the installer window. This download is not represented as code-signed.\n${downloaded.file}`
            : platform === 'linux'
              ? `Show the verified Recruiters.rip Companion ${release.version} AppImage for manual installation?\nQuit the companion, move this executable AppImage to your preferred application folder, then run it. Saved data stays in place.\n${downloaded.file}`
              : `Open Recruiters.rip Companion ${release.version} ZIP for manual installation?\n${downloaded.file}` }), signal);
      if (approved !== true) return update({ status: 'downloaded', error: { code: 'APPROVAL_DECLINED', message: 'The update was not installed. The verified download is ready when you choose to install it.' } });
      const manual = message => { update({ status: 'manual-required', error: { code: 'MANUAL_INSTALL_REQUIRED', message } }); return { manualPath: downloaded.file }; };
      if (platform === 'win32') return manual('The verified Windows installer is ready. Complete its installation steps, closing the companion when requested. Your saved data is retained; this is not an automatic replacement or a claim of code signing.');
      if (platform === 'linux') {
        await chmod(downloaded.file, 0o700);
        return { ...manual('The verified executable AppImage is shown in your file manager. Quit the companion, move it to your preferred application folder and run it instead of the previous AppImage. Your saved data is retained.'), reveal: true };
      }
      if (!packaged || !appPath) return manual('This is not a packaged macOS Apple silicon installation. Open the verified ZIP and install its app manually; this source checkout will not be replaced.');
      if (!Number.isSafeInteger(pid) || pid < 1 || typeof quit !== 'function') throw fail('INVALID_CONFIGURATION', 'The companion cannot safely hand over this update. Use the release page to install manually.');
      const target = path.resolve(appPath);
      if (!target.endsWith('.app') || target !== appPath || await realpath(target) !== target || !(await lstat(target)).isDirectory()) throw fail('INVALID_TARGET', 'Updates can replace only the actual installed app bundle, never a source checkout or linked app.');
      if (target.split(path.sep).includes('node_modules') || directory === target || directory.startsWith(`${target}${path.sep}`)) throw fail('INVALID_TARGET', 'The update target or private staging directory is unsafe. Use the release installer.');
      if (!(await realpath(process.execPath)).startsWith(`${target}${path.sep}`)) throw fail('INVALID_TARGET', 'Updates can replace only the app that is currently running, not a different app or a source checkout.');
      await validateBundle(target, version, signal, { signature: false });
      const parent = path.dirname(target);
      if (await realpath(parent) !== parent) throw fail('INVALID_TARGET', 'The app installation directory is linked. Use the release installer to update manually.');
      if ((await lstat(parent)).mode & 0o002) return manual('The app is in a shared writable directory. Move it to Applications or install the verified ZIP manually.');
      try { await access(parent, constants.W_OK | constants.X_OK); }
      catch { return manual('The installed app directory is not writable. Open the verified ZIP and replace the app using Finder with the permissions it requires.'); }
      const previous = await readActive();
      if (previous && !['confirmed', 'rolled-back', 'failed'].includes(previous.status)) return manual('A previous update is still unconfirmed. Quit the companion and reinstall from the verified ZIP; the retained previous app will not be overwritten.');
      const id = randomBytes(16).toString('hex');
      const work = path.join(directory, `install-${id}`);
      const staged = path.join(parent, `.recruiters-update-${id}.app`);
      const backup = path.join(parent, `.recruiters-backup-${id}.app`);
      let committed = false, stagedOwned = false;
      await mkdir(work, { mode: 0o700 });
      try {
        update({ status: 'staging' });
        const extracted = await extractUpdateZip(downloaded.file, path.join(work, 'extract'), signal);
        await validateBundle(extracted, release.version, signal);
        // ditto preserves the signed app's framework links and executable modes.
        // Destination is an unpredictable sibling, never an existing app.
        await mkdir(staged, { mode: 0o700 });
        stagedOwned = true;
        await system('/usr/bin/ditto', [extracted, staged], signal);
        await validateBundle(staged, release.version, signal);
        await rm(path.join(work, 'extract'), { recursive: true, force: true });
        const journal = { schema: 1, id, version: release.version, previousVersion: version, pid, target, staged, backup, journal: path.join(work, 'journal.json') };
        await installer.writeJournal(journal, 'staged');
        const helper = path.join(work, 'update-install.cjs');
        await copyFile(fileURLToPath(new URL('./update-install.cjs', import.meta.url)), helper, constants.COPYFILE_EXCL);
        await chmod(helper, 0o600);
        await writeFile(`${activeFile}.tmp`, JSON.stringify({ id }), { mode: 0o600 });
        await rename(`${activeFile}.tmp`, activeFile);
        throwIfAborted(signal);
        await launchHelper(helper, journal, process.execPath, signal);
        committed = true;
        handover = true;
        update({ status: 'installing' });
        // The ready helper has a receipt and an app staged beside the target.
        // It cannot swap until this process exits.
        quit();
        return state();
      } catch (error) {
        if (!committed) {
          if (stagedOwned) await rm(staged, { recursive: true, force: true });
          await rm(work, { recursive: true, force: true });
          await rm(activeFile, { force: true });
          if (['EACCES', 'EPERM', 'EROFS'].includes(error.code)) return manual('The app directory could not be updated. Open the verified ZIP and replace the app manually using Finder.');
        }
        throw error;
      }
    });
  }

  async function cancel() {
    if (handover) throw fail('INVALID_STATE', 'The approved update has already been handed to the installer.');
    if (!active || active.name === 'initialize updates') throw fail('INVALID_STATE', 'There is no cancellable update operation.');
    const pending = active.promise;
    active.controller.abort(fail('CANCELLED', 'The update was cancelled. The installed app and saved data were not changed.'));
    await pending.catch(() => {});
    return state();
  }

  return { initialize, state, check, download, install, cancel };
}
