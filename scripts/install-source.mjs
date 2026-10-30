#!/usr/bin/env node
// Standalone release asset: built-ins only. Builds source, never downloads an app binary.
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn, execFileSync } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const REPOSITORY = 'https://github.com/jobstash/recruiters-rip-companion';
const API = 'https://api.github.com/repos/jobstash/recruiters-rip-companion';
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const SHA = /^[a-f0-9]{40}$/;
export const sourceError = (code, message) => Object.assign(new Error(message), { code, publicUpdateError: true });
const abort = signal => { if (signal?.aborted) throw signal.reason || sourceError('CANCELLED', 'Source build cancelled.'); };
export function compareSourceVersions(a, b) {
  if (!VERSION.test(a) || !VERSION.test(b)) throw sourceError('INVALID_VERSION', 'A stable source version is required.');
  const left = a.split('.').map(Number), right = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i] < right[i] ? -1 : 1;
  return 0;
}
export function sourceEnvironment(tools) {
  const keys = ['PATH', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT', 'TMP', 'TEMP', 'TMPDIR', 'DISPLAY', 'WAYLAND_DISPLAY', 'XAUTHORITY', 'DBUS_SESSION_BUS_ADDRESS', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_RUNTIME_DIR'];
  const env = Object.fromEntries(keys.filter(key => process.env[key]).map(key => [key, process.env[key]]));
  if (tools) env.PATH = [path.dirname(tools.node), path.dirname(tools.git), tools.bin, env.PATH].filter(Boolean).join(path.delimiter);
  // Git for Windows accepts its NUL device name, not Node's Win32 \\.\nul path.
  return { ...env, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : os.devNull, GIT_ALLOW_PROTOCOL: 'https:file', CI: 'true' };
}
export function runSourceCommand(executable, args, { cwd, env = sourceEnvironment(), signal, timeout = 20 * 60 * 1000, maxOutput = 4 * 1024 * 1024 } = {}) {
  abort(signal);
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd, env, shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', size = 0, failure, settled = false;
    const stop = error => {
      if (failure) return;
      failure = error;
      if (!child.pid) return;
      try {
        if (process.platform === 'win32') execFileSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe'), ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore', timeout: 10000 });
        else process.kill(-child.pid, 'SIGKILL');
      } catch { child.kill('SIGKILL'); }
    };
    const onAbort = () => stop(signal.reason || sourceError('CANCELLED', 'Source build cancelled.'));
    const timer = setTimeout(() => stop(sourceError('BUILD_TIMEOUT', 'The source build timed out; the current installation is unchanged.')), timeout);
    signal?.addEventListener('abort', onAbort, { once: true });
    const finish = error => {
      if (settled) return;
      settled = true; clearTimeout(timer); signal?.removeEventListener('abort', onAbort);
      if (error) reject(error); else resolve(output);
    };
    const consume = chunk => {
      size += chunk.length;
      if (size > maxOutput) stop(sourceError('BUILD_OUTPUT_LIMIT', 'The source command exceeded its output limit.'));
      else output += chunk.toString('utf8');
    };
    child.stdout.on('data', consume); child.stderr.on('data', consume);
    child.once('error', error => finish(failure || error));
    child.once('close', code => finish(failure || (code === 0 ? null : sourceError('SOURCE_COMMAND_FAILED', `${path.basename(executable)} failed (${code}): ${output.slice(-3000)}`))));
    if (signal?.aborted) onAbort();
  });
}

const WINDOWS_MODULE_BOOTSTRAP = "$ErrorActionPreference='Stop';$originalPSModulePath=$env:PSModulePath;try{$env:PSModulePath=[IO.Path]::Combine($PSHOME,'Modules');Import-Module -Name ([IO.Path]::Combine($PSHOME,'Modules','Microsoft.PowerShell.Management','Microsoft.PowerShell.Management.psd1')) -Force -ErrorAction Stop;Import-Module -Name ([IO.Path]::Combine($PSHOME,'Modules','Microsoft.PowerShell.Security','Microsoft.PowerShell.Security.psd1')) -Force -ErrorAction Stop}finally{$env:PSModulePath=$originalPSModulePath};";

function windowsPrivate(directory, protect) {
  const encoded = Buffer.from(directory, 'utf8').toString('base64');
  const script = `$ErrorActionPreference='Stop';$p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}'));$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User;$allowed=@($sid.Value,'S-1-5-18','S-1-5-32-544');$a=[IO.Directory]::GetAccessControl($p);if($a.GetOwner([Security.Principal.SecurityIdentifier]).Value -notin $allowed){throw 'Foreign owner'};` +
    (protect ? `$a.SetAccessRuleProtection($true,$false);foreach($r in @($a.Access)){$a.RemoveAccessRuleSpecific($r)};foreach($s in $allowed){$r=[Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($s),[Security.AccessControl.FileSystemRights]::FullControl,([Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit),[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow);$a.AddAccessRule($r)};[IO.Directory]::SetAccessControl($p,$a);` : '') +
    `$own=$false;foreach($r in $a.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])){if($r.AccessControlType -eq 'Allow'){if($r.IdentityReference.Value -notin $allowed){throw 'Public access'};if($r.IdentityReference.Value -eq $sid.Value){$own=$true}}};if(-not $own){throw 'Missing owner access'}`;
  execFileSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(WINDOWS_MODULE_BOOTSTRAP + script, 'utf16le').toString('base64')], { env: sourceEnvironment(), windowsHide: true, stdio: 'pipe', timeout: 15000 });
}

export function assertWindowsSourcePath(filename, { privateLeaf = false, file = false } = {}) {
  const encoded = Buffer.from(filename, 'utf8').toString('base64');
  // Only the OS-supplied Windows PowerShell 5.1 host is used, not a PATH tool.
  // Creation-only ACEs on an ancestor are safe only because every selected child
  // also has a trusted owner and no untrusted DELETE/DELETE_CHILD/control rights.
  const script = `$ErrorActionPreference='Stop';$p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}'));$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value;$allowed=@($sid,'S-1-5-18','S-1-5-32-544','S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464');$entries=@();$d=${file ? '[IO.Path]::GetDirectoryName($p)' : '$p'};while($d){$entries+=@{Path=$d;File=$false};$parent=[IO.Directory]::GetParent($d);if($null -eq $parent){break};$d=$parent.FullName};${file ? '$entries+=@{Path=$p;File=$true};' : ''}` +
    `$danger=[int64]([Security.AccessControl.FileSystemRights]::Delete -bor [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor [Security.AccessControl.FileSystemRights]::ChangePermissions -bor [Security.AccessControl.FileSystemRights]::TakeOwnership -bor [Security.AccessControl.FileSystemRights]::WriteAttributes -bor [Security.AccessControl.FileSystemRights]::WriteExtendedAttributes);$creation=[int64]([Security.AccessControl.FileSystemRights]::CreateFiles -bor [Security.AccessControl.FileSystemRights]::CreateDirectories);` +
    `foreach($entry in $entries){if(([IO.File]::GetAttributes($entry.Path) -band [IO.FileAttributes]::ReparsePoint) -ne 0){throw 'Linked source ancestor'};$a=if($entry.File){[IO.File]::GetAccessControl($entry.Path)}else{[IO.Directory]::GetAccessControl($entry.Path)};if($a.GetOwner([Security.Principal.SecurityIdentifier]).Value -notin $allowed){throw 'Foreign source ancestor owner'};$raw=[Security.AccessControl.RawSecurityDescriptor]::new($a.GetSecurityDescriptorBinaryForm(),0);if($null -eq $raw.DiscretionaryAcl){throw 'Unrestricted source ancestor'};$own=$false;foreach($r in $a.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])){if(($r.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly) -ne 0 -or $r.AccessControlType -ne 'Allow'){continue};$who=$r.IdentityReference.Value;if($who -eq $sid){$own=$true};if($who -notin $allowed){$rights=[int64]$r.FileSystemRights;if((${privateLeaf ? '$true' : '$false'} -and $entry.Path -eq $p) -or (($rights -band $danger) -ne 0) -or ($entry.File -and (($rights -band $creation) -ne 0))){throw 'Replaceable source path'}}};if(${privateLeaf ? '$true' : '$false'} -and $entry.Path -eq $p -and -not $own){throw 'Missing private owner access'}}`;
  try {
    execFileSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(WINDOWS_MODULE_BOOTSTRAP + script, 'utf16le').toString('base64')], { env: sourceEnvironment(), windowsHide: true, stdio: 'pipe', timeout: 15000, maxBuffer: 65536 });
  } catch { throw sourceError('UNSAFE_SOURCE_ANCESTOR', 'The source path can be replaced or accessed by another account. Choose a private directory beneath your home folder.'); }
}

export async function assertSourceAncestors(directory, { privateLeaf = false } = {}) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory) || path.resolve(directory) !== directory || await fs.realpath(directory) !== directory) throw sourceError('INVALID_SOURCE_PATH', 'Source ancestors must be canonical real directories.');
  if (process.platform === 'win32') { assertWindowsSourcePath(directory, { privateLeaf }); return; }
  for (let current = directory;; current = path.dirname(current)) {
    const info = await fs.lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink() || ![0, process.getuid()].includes(info.uid) || ((info.mode & 0o022) && !(info.mode & 0o1000))) throw sourceError('UNSAFE_SOURCE_ANCESTOR', 'Another account can replace a source path component. Choose a private directory beneath your home folder.');
    // macOS ACLs can grant writes without changing POSIX group/other mode bits.
    if (process.platform === 'darwin') {
      const acl = execFileSync('/bin/ls', ['-lde', current], { env: { ...sourceEnvironment(), LC_ALL: 'C' }, encoding: 'utf8', timeout: 15000, maxBuffer: 65536 });
      if (/^\s*\d+:.*\ballow\b.*\b(?:add_file|add_subdirectory|delete_child|writeattr|writeextattr|writesecurity|chown|delete)\b/m.test(acl)) throw sourceError('UNSAFE_SOURCE_ANCESTOR', 'A source ancestor has an extended write ACL. Choose a private directory without shared write access.');
    }
    if (current === path.dirname(current)) break;
  }
}

function assertSourceStarterPath(directory, platform = process.platform) {
  if (platform === 'win32' && /[%"]/.test(directory)) throw sourceError('INVALID_SOURCE_PATH', 'Choose another source folder without percent signs or double quotes. Windows cannot safely open the generated starter from that path.');
}

async function prepareSourceParent(directory) {
  const missing = [];
  let existing = directory;
  for (;;) {
    try { await fs.lstat(existing); break; }
    catch (error) { if (error.code !== 'ENOENT') throw error; missing.unshift(path.basename(existing)); existing = path.dirname(existing); }
  }
  let parent = await fs.realpath(existing);
  assertSourceStarterPath(path.join(parent, ...missing));
  await assertSourceAncestors(parent);
  for (const name of missing) {
    parent = path.join(parent, name);
    let created = false;
    try { await fs.mkdir(parent, { mode: 0o700 }); created = true; } catch (error) { if (error.code !== 'EEXIST') throw error; }
    if (created && process.platform === 'win32') windowsPrivate(parent, true);
    await assertSourceDirectory(parent);
    await assertSourceAncestors(parent);
  }
  return parent;
}
export async function assertSourceDirectory(directory, { privateRoot = false } = {}) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory) || path.resolve(directory) !== directory || /[\0\r\n]/.test(directory)) throw sourceError('INVALID_SOURCE_PATH', 'Source paths must be absolute, real directories.');
  const info = await fs.lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || await fs.realpath(directory) !== directory || (process.getuid && info.uid !== process.getuid())) throw sourceError('INVALID_SOURCE_PATH', 'A source path is linked or owned by another user.');
  if (process.platform === 'win32') {
    await assertSourceAncestors(directory, { privateLeaf: privateRoot });
  } else if (privateRoot) {
    await assertSourceAncestors(directory, { privateLeaf: true });
    if (info.mode & 0o077) throw sourceError('INVALID_SOURCE_PATH', 'The managed source directory must be private.');
  }
}
export async function readSourceJSON(file) {
  const info = await fs.lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 65536 || (process.getuid && info.uid !== process.getuid())) throw sourceError('INVALID_SOURCE_RECEIPT', 'Invalid managed source receipt.');
  return JSON.parse(await fs.readFile(file, 'utf8'));
}
export async function writeSourceJSON(file, data) {
  const temporary = `${file}.${randomBytes(8).toString('hex')}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(data), { flag: 'wx', mode: 0o600 });
  await fs.rename(temporary, file);
}
export function defaultSourceRoot() {
  return path.join(os.homedir(), '.recruiters-rip', 'source');
}
export async function prepareSourceRoot(value = defaultSourceRoot()) {
  if (!path.isAbsolute(value) || path.resolve(value) !== value || /[\0\r\n]/.test(value) || path.dirname(value) === value) throw sourceError('INVALID_SOURCE_PATH', 'Choose a private managed source folder.');
  assertSourceStarterPath(value);
  const parent = await prepareSourceParent(path.dirname(value));
  const root = path.join(parent, path.basename(value));
  let created = false;
  try { await fs.mkdir(root, { mode: 0o700 }); created = true; } catch (error) { if (error.code !== 'EEXIST') throw error; }
  if (created && process.platform === 'win32') windowsPrivate(root, true);
  await assertSourceDirectory(root, { privateRoot: true });
  const identity = path.join(root, 'managed.json');
  if (created) await writeSourceJSON(identity, { schema: 1, root, product: 'rip.recruiters.companion' });
  const marker = await readSourceJSON(identity);
  if (marker.schema !== 1 || marker.root !== root || marker.product !== 'rip.recruiters.companion') throw sourceError('INVALID_SOURCE_RECEIPT', 'The destination is not an owned managed source installation.');
  for (const child of ['versions', 'tools', 'transitions']) {
    const directory = path.join(root, child);
    await fs.mkdir(directory, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
    await assertSourceDirectory(directory);
  }
  return root;
}

async function findTool(name, candidates, signal, accepts) {
  for (const candidate of new Set(candidates)) {
    abort(signal);
    if (!candidate || !path.isAbsolute(candidate) || path.resolve(candidate) !== candidate || /[\0\r\n]/.test(candidate)) continue;
    try {
      // Resolve to validate the target, but retain the stable symlink/entrypoint.
      if (!(await fs.stat(await fs.realpath(candidate))).isFile()) continue;
      const result = (await runSourceCommand(candidate, ['--version'], { signal, timeout: 15000 })).trim();
      if (accepts(result)) return candidate;
    } catch (error) { abort(signal); /* Missing, obsolete or unusable tool: try the next installation. */ }
  }
  throw sourceError('MISSING_PREREQUISITE', `Install ${name === 'node' ? 'Node.js 24 (including npm)' : 'Git'} and run the source installer again.`);
}
export function sourceToolDirectories(env = process.env) {
  const programs = env.ProgramFiles || 'C:\\Program Files';
  return process.platform === 'win32'
    ? [path.join(programs, 'nodejs'), path.join(programs, 'Git', 'cmd'), ...(env.PATH || '').split(path.delimiter)]
    : ['/opt/homebrew/opt/node@24/bin', '/usr/local/opt/node@24/bin', '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', ...(env.PATH || '').split(path.delimiter)];
}
export async function discoverSourceTools(saved, signal, { directories } = {}) {
  const suffix = process.platform === 'win32' ? '.exe' : '';
  const candidates = name => (directories || sourceToolDirectories()).filter(directory => directory && path.isAbsolute(directory)).map(directory => path.join(directory, `${name}${suffix}`));
  const node = await findTool('node', [...candidates('node'), saved?.node, ...(!process.versions.electron && directories === undefined ? [process.execPath] : [])], signal, value => /^v24\.\d+\.\d+$/.test(value));
  const git = await findTool('git', [...candidates('git'), saved?.git], signal, value => /^git version \d+\./.test(value));
  // npm belongs to the selected Node installation, not the old receipt's keg.
  let npm;
  for (const executable of new Set([node, await fs.realpath(node)])) {
    for (const candidate of [path.join(path.dirname(executable), 'node_modules', 'npm', 'bin', 'npm-cli.js'), path.resolve(path.dirname(executable), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'), path.resolve(path.dirname(executable), '..', 'share', 'nodejs', 'npm', 'bin', 'npm-cli.js')]) {
      abort(signal);
      try {
        if (!(await fs.stat(await fs.realpath(candidate))).isFile()) continue;
        const result = (await runSourceCommand(node, [candidate, '--version'], { signal, timeout: 15000 })).trim();
        if (/^\d+\.\d+\.\d+$/.test(result)) { npm = candidate; break; }
      } catch (error) { if (signal?.aborted) throw error; /* Re-derive npm from the replacement Node installation. */ }
    }
    if (npm) break;
  }
  if (!npm) throw sourceError('MISSING_PREREQUISITE', 'npm is missing. Install Node.js 24 including npm.');
  return { node, git, npm };
}
async function githubJSON(url, fetchImpl, signal) {
  abort(signal);
  signal = signal ? AbortSignal.any([signal, AbortSignal.timeout(120000)]) : AbortSignal.timeout(120000);
  const response = await fetchImpl(url, { signal, redirect: 'error', headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Recruiters-rip-source-installer' } });
  if (!response.ok) throw sourceError('SOURCE_RELEASE_UNAVAILABLE', `Official source metadata is unavailable (${response.status}).`);
  const reader = response.body.getReader(); let size = 0, chunks = [];
  try { for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > 1024 * 1024) throw sourceError('SOURCE_RELEASE_UNAVAILABLE', 'Official source metadata is too large.'); chunks.push(Buffer.from(value)); } }
  finally { await reader.cancel().catch(() => {}); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
export async function resolveOfficialSource({ fetchImpl = globalThis.fetch, signal, version } = {}) {
  if (version && !VERSION.test(version)) throw sourceError('INVALID_VERSION', 'Invalid source release version.');
  const release = await githubJSON(`${API}/releases/${version ? `tags/v${version}` : 'latest'}`, fetchImpl, signal);
  if (release.draft || release.prerelease || !/^v\d+\.\d+\.\d+$/.test(release.tag_name) || !VERSION.test(release.tag_name.slice(1)) || (version && release.tag_name !== `v${version}`) || release.html_url !== `${REPOSITORY}/releases/tag/${release.tag_name}`) throw sourceError('INVALID_SOURCE_RELEASE', 'Only official published stable source releases can be installed automatically.');
  const ref = await githubJSON(`${API}/commits/${encodeURIComponent(release.tag_name)}`, fetchImpl, signal);
  if (!SHA.test(ref.sha)) throw sourceError('INVALID_SOURCE_RELEASE', 'The official release has no exact source commit.');
  return { version: release.tag_name.slice(1), tag: release.tag_name, commit: ref.sha, provenance: 'official-release', releaseUrl: release.html_url };
}
export async function assertCleanSource(sourceRoot, tools, signal) {
  await assertSourceDirectory(sourceRoot);
  const top = (await runSourceCommand(tools.git, ['-C', sourceRoot, 'rev-parse', '--show-toplevel'], { signal, timeout: 15000 })).trim();
  if (await fs.realpath(top) !== sourceRoot) throw sourceError('INVALID_SOURCE_PATH', 'The source root is not the actual Git checkout.');
  const status = await runSourceCommand(tools.git, ['-C', sourceRoot, 'status', '--porcelain=v1', '--untracked-files=all'], { signal, timeout: 30000 });
  if (status.trim()) throw sourceError('SOURCE_MODIFIED', 'Local source edits pause automatic updates. Commit or move your changes before updating; no files were discarded.');
}
export async function validateSourceRelease(release, tools, signal) {
  if (!release || !VERSION.test(release.version) || !SHA.test(release.commit) || release.tag !== `v${release.version}` || !['official-release', 'local-candidate'].includes(release.provenance)) throw sourceError('INVALID_SOURCE_RELEASE', 'An exact stable source version and commit are required.');
  if (release.provenance === 'local-candidate') {
    if (!release.checkout) throw sourceError('INVALID_SOURCE_RELEASE', 'A local candidate requires an explicit clean checkout.');
    await assertCleanSource(release.checkout, tools, signal);
    const head = (await runSourceCommand(tools.git, ['-C', release.checkout, 'rev-parse', 'HEAD'], { signal })).trim();
    if (head !== release.commit) throw sourceError('INVALID_SOURCE_RELEASE', 'The local candidate checkout does not match the requested commit.');
  } else if (release.checkout || release.releaseUrl !== `${REPOSITORY}/releases/tag/${release.tag}`) throw sourceError('INVALID_SOURCE_RELEASE', 'Invalid official source origin.');
  return release;
}
export function sourceExecutable(sourceRoot, platform = process.platform) {
  return path.join(sourceRoot, 'node_modules', 'electron', 'dist', ...(platform === 'darwin' ? ['Electron.app', 'Contents', 'MacOS', 'Electron'] : [platform === 'win32' ? 'electron.exe' : 'electron']));
}
export async function validateSourceBuild(sourceRoot, version) {
  const metadata = await readSourceJSON(path.join(sourceRoot, 'package.json'));
  if (metadata.version !== version || metadata.name !== 'recruiters-companion' || metadata.localProduct || metadata.build?.appId !== 'rip.recruiters.companion' || metadata.main !== 'src/main.mjs' || !/^pnpm@\d+\.\d+\.\d+$/.test(metadata.packageManager)) throw sourceError('INVALID_SOURCE_BUILD', 'The source build does not match the production release identity.');
  for (const relative of ['src/main.mjs', 'src/generated/document-engine.cjs', 'src/generated/mcp-host.cjs', 'src/generated/skill-digest.mjs', 'browser-extension/dist/production/manifest.json']) {
    const info = await fs.lstat(path.join(sourceRoot, relative));
    if (!info.isFile() || info.isSymbolicLink() || !info.size) throw sourceError('INVALID_SOURCE_BUILD', 'The source build is incomplete.');
  }
  for (const browser of ['production', 'firefox-production']) {
    const manifest = await readSourceJSON(path.join(sourceRoot, 'browser-extension', 'dist', browser, 'manifest.json'));
    if (manifest.version !== version) throw sourceError('INVALID_SOURCE_BUILD', 'The bundled browser extension does not match the source version.');
  }
  const executable = sourceExecutable(sourceRoot);
  const resolved = await fs.realpath(executable);
  if (!resolved.startsWith(`${sourceRoot}${path.sep}`) || !(await fs.stat(resolved)).isFile()) throw sourceError('INVALID_SOURCE_BUILD', 'The built Electron runtime escapes its source installation.');
  const electronPackage = await readSourceJSON(path.join(sourceRoot, 'node_modules', 'electron', 'package.json'));
  const electronVersion = (await fs.readFile(path.join(sourceRoot, 'node_modules', 'electron', 'dist', 'version'), 'utf8')).trim().replace(/^v/, '');
  if (electronPackage.version !== metadata.devDependencies?.electron || electronVersion !== electronPackage.version) throw sourceError('INVALID_SOURCE_BUILD', 'The installed Electron binary does not match the pinned runtime package.');
  return metadata;
}

export async function installSourceElectron({ sourceRoot, tools, cache, version, signal }) {
  const installer = path.join(sourceRoot, 'node_modules', 'electron', 'install.js');
  const metadata = await readSourceJSON(path.join(sourceRoot, 'node_modules', 'electron', 'package.json'));
  if (!VERSION.test(version) || metadata.version !== version) throw sourceError('INVALID_SOURCE_BUILD', 'The installed Electron package does not match the pinned runtime version.');
  for (const filename of [installer, path.join(path.dirname(installer), 'checksums.json')]) {
    const resolved = await fs.realpath(filename);
    if (!resolved.startsWith(`${sourceRoot}${path.sep}`) || !(await fs.lstat(resolved)).isFile()) throw sourceError('INVALID_SOURCE_BUILD', 'The pinned Electron installer or bundled checksums escape the source installation.');
  }
  // Electron 45 installs its binary lazily. Run its pinned installer explicitly;
  // let that package verify its bundled checksums, rather than bypassing it.
  // Choose architecture inside the SAME Node used for dependency installation:
  // an already-running Electron parent may have a different architecture.
  const install = 'process.env.npm_config_arch=process.arch;process.env.ELECTRON_INSTALL_ARCH=process.arch;process.env.npm_config_platform=process.platform;process.env.ELECTRON_INSTALL_PLATFORM=process.platform;require(process.argv[1]);';
  return runSourceCommand(tools.node, ['-e', install, installer], {
    cwd: sourceRoot, signal,
    env: { ...sourceEnvironment(tools), electron_config_cache: cache, ELECTRON_CACHE: cache },
  });
}

export async function buildSourceVersion({ root, release, tools, signal, onProgress = () => {} }) {
  await assertSourceDirectory(root, { privateRoot: true });
  await validateSourceRelease(release, tools, signal);
  const id = `${release.version}-${release.commit.slice(0, 12)}-${randomBytes(8).toString('hex')}`;
  const versionRoot = path.join(root, 'versions', id), sourceRoot = path.join(versionRoot, 'source');
  await fs.mkdir(versionRoot, { mode: 0o700 });
  // Failed/cancelled builds are retained in their owned version folder, never removed recursively.
  onProgress('Cloning the exact source commit');
  await runSourceCommand(tools.git, ['clone', '--no-checkout', '--no-hardlinks', ...(release.provenance === 'official-release' ? ['--depth', '1', '--single-branch', '--branch', release.tag] : []), '--', release.checkout || `${REPOSITORY}.git`, sourceRoot], { signal, timeout: 5 * 60 * 1000 });
  if (release.provenance === 'official-release') {
    const tagged = (await runSourceCommand(tools.git, ['-C', sourceRoot, 'rev-parse', `refs/tags/${release.tag}^{commit}`], { signal })).trim();
    if (tagged !== release.commit) throw sourceError('INVALID_SOURCE_RELEASE', 'The published source tag changed while downloading.');
  }
  await runSourceCommand(tools.git, ['-C', sourceRoot, 'checkout', '--detach', release.commit], { signal });
  const metadata = await readSourceJSON(path.join(sourceRoot, 'package.json'));
  if (metadata.version !== release.version || metadata.name !== 'recruiters-companion' || metadata.localProduct || metadata.build?.appId !== 'rip.recruiters.companion' || !/^pnpm@\d+\.\d+\.\d+$/.test(metadata.packageManager)) throw sourceError('INVALID_SOURCE_RELEASE', 'The source commit and package version do not match the selected release.');
  const lockfile = path.join(sourceRoot, 'pnpm-lock.yaml');
  const lock = await fs.readFile(lockfile);
  const managerVersion = metadata.packageManager.slice(5);
  const managerRoot = path.join(root, 'tools', `pnpm-${managerVersion}-${randomBytes(6).toString('hex')}`);
  await fs.mkdir(managerRoot, { mode: 0o700 });
  onProgress('Installing the pinned package manager and locked dependencies');
  const cacheEnvironment = { npm_config_cache: path.join(root, 'tools', 'npm-cache'), NPM_CONFIG_USERCONFIG: path.join(managerRoot, 'user.npmrc'), NPM_CONFIG_GLOBALCONFIG: path.join(managerRoot, 'global.npmrc'), electron_config_cache: path.join(root, 'tools', 'electron-cache'), ELECTRON_CACHE: path.join(root, 'tools', 'electron-cache') };
  await fs.writeFile(cacheEnvironment.NPM_CONFIG_USERCONFIG, '', { flag: 'wx', mode: 0o600 });
  await fs.writeFile(cacheEnvironment.NPM_CONFIG_GLOBALCONFIG, '', { flag: 'wx', mode: 0o600 });
  await runSourceCommand(tools.node, [tools.npm, 'install', '--prefix', managerRoot, '--registry=https://registry.npmjs.org', '--ignore-scripts', '--no-audit', '--no-fund', metadata.packageManager], { signal, env: { ...sourceEnvironment(tools), ...cacheEnvironment } });
  const pnpm = path.join(managerRoot, 'node_modules', 'pnpm', 'bin', 'pnpm.cjs');
  const buildTools = { ...tools, bin: path.join(managerRoot, 'node_modules', '.bin') };
  const env = { ...sourceEnvironment(buildTools), ...cacheEnvironment };
  await runSourceCommand(tools.node, [pnpm, 'install', '--frozen-lockfile', '--store-dir', path.join(root, 'tools', 'pnpm-store')], { cwd: sourceRoot, signal, env });
  if (!(await fs.readFile(lockfile)).equals(lock)) throw sourceError('LOCKFILE_CHANGED', 'The frozen dependency lockfile changed.');
  onProgress('Installing and verifying the pinned Electron runtime');
  await installSourceElectron({ sourceRoot, tools, cache: cacheEnvironment.electron_config_cache, version: metadata.devDependencies?.electron, signal });
  onProgress('Building the production app locally');
  await runSourceCommand(tools.node, [pnpm, 'run', 'build'], { cwd: sourceRoot, signal, env });
  await validateSourceBuild(sourceRoot, release.version);
  await assertCleanSource(sourceRoot, tools, signal);
  const receipt = { schema: 1, root, sourceRoot, version: release.version, commit: release.commit, provenance: release.provenance, tag: release.tag, lockDigest: createHash('sha256').update(lock).digest('hex'), tools, createdAt: new Date().toISOString() };
  await writeSourceJSON(path.join(versionRoot, 'receipt.json'), receipt);
  return receipt;
}
export async function readManagedSource(sourceRoot, { version } = {}) {
  await assertSourceDirectory(sourceRoot);
  const versionRoot = path.dirname(sourceRoot), root = path.dirname(path.dirname(versionRoot));
  if (path.basename(sourceRoot) !== 'source' || path.dirname(versionRoot) !== path.join(root, 'versions')) throw sourceError('UNMANAGED_SOURCE', 'This is an ordinary source checkout. Use the source installer for managed automatic builds.');
  await assertSourceDirectory(root, { privateRoot: true });
  await assertSourceDirectory(path.join(root, 'versions'));
  await assertSourceDirectory(versionRoot);
  const marker = await readSourceJSON(path.join(root, 'managed.json'));
  const receipt = await readSourceJSON(path.join(versionRoot, 'receipt.json'));
  if (marker.schema !== 1 || marker.root !== root || marker.product !== 'rip.recruiters.companion' || receipt.schema !== 1 || receipt.root !== root || receipt.sourceRoot !== sourceRoot || !VERSION.test(receipt.version) || !SHA.test(receipt.commit) || !/^[a-f0-9]{64}$/.test(receipt.lockDigest) || (version && receipt.version !== version) || !['official-release', 'local-candidate'].includes(receipt.provenance)) throw sourceError('INVALID_SOURCE_RECEIPT', 'The source receipt does not belong to this running checkout.');
  for (const key of ['node', 'git', 'npm']) if (typeof receipt.tools?.[key] !== 'string' || !path.isAbsolute(receipt.tools[key])) throw sourceError('INVALID_SOURCE_RECEIPT', 'The source tool paths are invalid.');
  const metadata = await readSourceJSON(path.join(sourceRoot, 'package.json'));
  if (metadata.version !== receipt.version || metadata.name !== 'recruiters-companion' || metadata.localProduct) throw sourceError('INVALID_SOURCE_RECEIPT', 'The running package does not match its managed receipt.');
  return receipt;
}
export async function assertInstalledSource(sourceRoot, tools, signal) {
  const receipt = await readManagedSource(sourceRoot);
  tools ||= await discoverSourceTools(receipt.tools, signal);
  await assertCleanSource(sourceRoot, tools, signal);
  const head = (await runSourceCommand(tools.git, ['-C', sourceRoot, 'rev-parse', 'HEAD'], { signal, timeout: 15000 })).trim();
  const digest = createHash('sha256').update(await fs.readFile(path.join(sourceRoot, 'pnpm-lock.yaml'))).digest('hex');
  if (head !== receipt.commit || digest !== receipt.lockDigest) throw sourceError('SOURCE_MODIFIED', 'This managed checkout differs from its installed commit. Automatic source updates are paused; no changes will be discarded.');
  return receipt;
}

export function sourceLauncherText(root, node, platform = process.platform) {
  for (const value of [root, node]) if (!path.isAbsolute(value) || /[\0\r\n]/.test(value)) throw sourceError('INVALID_SOURCE_PATH', 'Invalid source launcher path.');
  const launcher = path.join(root, 'launch.mjs');
  if (platform === 'win32') {
    assertSourceStarterPath(root, platform);
    if (node.includes('"')) throw sourceError('INVALID_SOURCE_PATH', 'The Node executable path contains an unsupported quote.');
    const quote = value => `"${value.replaceAll('%', '%%')}"`;
    const probe = `-e "process.exit(process.versions.node.startsWith('24.')?0:1)" >nul 2>nul`;
    return [
      '@echo off',
      'setlocal DisableDelayedExpansion',
      'set "NODE_OPTIONS="',
      'set "NODE_PATH="',
      'set "ELECTRON_RUN_AS_NODE="',
      'pushd "%~dp0" >nul 2>nul',
      'if errorlevel 1 exit /b 1',
      `if not exist ${quote(node)} goto source_standard`,
      `${quote(node)} ${probe}`,
      'if errorlevel 1 goto source_standard',
      `${quote(node)} ${quote(launcher)} %*`,
      'goto source_finish',
      ':source_standard',
      'if not exist "%ProgramFiles%\\nodejs\\node.exe" goto source_path',
      `"%ProgramFiles%\\nodejs\\node.exe" ${probe}`,
      'if errorlevel 1 goto source_path',
      `"%ProgramFiles%\\nodejs\\node.exe" ${quote(launcher)} %*`,
      'goto source_finish',
      ':source_path',
      `node.exe ${probe}`,
      'if errorlevel 1 goto source_missing',
      `node.exe ${quote(launcher)} %*`,
      'goto source_finish',
      ':source_missing',
      '>&2 echo Install Node.js 24 including npm, then open this launcher again.',
      'popd',
      'exit /b 1',
      ':source_finish',
      'set "source_exit=%errorlevel%"',
      'popd',
      'exit /b %source_exit%',
      '',
    ].join('\r\n');
  }
  const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
  const known = [node, '/opt/homebrew/opt/node@24/bin/node', '/usr/local/opt/node@24/bin/node', '/opt/homebrew/bin/node', '/usr/local/bin/node', '/usr/bin/node'];
  return `#!/bin/sh\nfor candidate in ${[...new Set(known)].map(quote).join(' ')} \"$(command -v node 2>/dev/null)\"; do\n  case \"$candidate\" in /*) ;; *) continue ;; esac\n  [ -f \"$candidate\" ] && [ -x \"$candidate\" ] || continue\n  version=$(\"$candidate\" --version 2>/dev/null) || continue\n  case \"$version\" in v24.[0-9]*.[0-9]*) exec \"$candidate\" ${quote(launcher)} \"$@\" ;; esac\ndone\nprintf '%s\\n' 'Install Node.js 24 (including npm), then open this launcher again.' >&2\nexit 1\n`;
}

export async function writeSourceLauncher(root, tools, { previousTools } = {}) {
  const file = path.join(root, process.platform === 'win32' ? 'launch.cmd' : 'launch');
  const text = sourceLauncherText(root, tools.node);
  if (!previousTools) { await fs.writeFile(file, text, { mode: 0o700, flag: 'wx' }); return true; }
  const info = await fs.lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 65536) throw sourceError('INVALID_SOURCE_PATH', 'The source launcher is not a regular owned file.');
  const current = await fs.readFile(file, 'utf8');
  if (current === text) return false;
  if (current !== sourceLauncherText(root, previousTools.node)) throw sourceError('SOURCE_LAUNCHER_MODIFIED', 'The managed launcher has local edits. They were preserved; run the launch.mjs file with Node.js 24 or move your launcher edits before repairing it.');
  const temporary = `${file}.${randomBytes(8).toString('hex')}.tmp`;
  await fs.writeFile(temporary, text, { flag: 'wx', mode: 0o700 });
  await fs.rename(temporary, file);
  return true;
}
export async function repairManagedSourceTools(root, tools) {
  await assertSourceDirectory(root, { privateRoot: true });
  const current = await readSourceJSON(path.join(root, 'current.json'));
  if (current.schema !== 1) throw sourceError('INVALID_SOURCE_RECEIPT', 'Invalid managed source pointer.');
  const receipt = await readManagedSource(current.sourceRoot, { version: current.version });
  if (receipt.root !== root) throw sourceError('INVALID_SOURCE_RECEIPT', 'The source pointer belongs to another installation.');
  for (const key of ['node', 'git', 'npm']) if (typeof tools[key] !== 'string' || !path.isAbsolute(tools[key]) || /[\0\r\n]/.test(tools[key])) throw sourceError('MISSING_PREREQUISITE', 'Invalid replacement source tools.');
  let repaired = await writeSourceLauncher(root, tools, { previousTools: receipt.tools });
  if (['node', 'git', 'npm'].some(key => receipt.tools[key] !== tools[key])) {
    receipt.tools = { node: tools.node, git: tools.git, npm: tools.npm };
    await writeSourceJSON(path.join(path.dirname(receipt.sourceRoot), 'receipt.json'), receipt);
    repaired = true;
  }
  return { receipt, repaired };
}

export async function installSource({ root: requestedRoot, checkout, commit, profile, noLaunch = false, fetchImpl, signal, onProgress = message => console.log(message) } = {}) {
  const root = await prepareSourceRoot(requestedRoot);
  const lockFile = path.join(root, 'bootstrap.lock');
  let lock;
  try { lock = await fs.open(lockFile, 'wx', 0o600); }
  catch (error) { if (error.code === 'EEXIST') throw sourceError('SOURCE_INSTALL_BUSY', 'Another bootstrap owns this source directory. If it was interrupted, choose a new private --root; the existing files are retained.'); throw error; }
  try {
  let previous;
  try { previous = await readSourceJSON(path.join(root, 'current.json')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (previous) {
    if (checkout || commit || profile) throw sourceError('SOURCE_ALREADY_INSTALLED', 'This managed installation already exists. Repair its launcher without checkout/profile overrides, or choose a separate private --root.');
    const installed = await readManagedSource(previous.sourceRoot, { version: previous.version });
    const tools = await discoverSourceTools(installed.tools, signal);
    const { receipt, repaired } = await repairManagedSourceTools(root, tools);
    if (!noLaunch) {
      const child = spawn(tools.node, [path.join(root, 'launch.mjs')], { detached: true, env: sourceEnvironment(tools), stdio: 'ignore' });
      await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); }); child.unref();
    }
    return { root, sourceRoot: receipt.sourceRoot, version: receipt.version, commit: receipt.commit, launcher: path.join(root, process.platform === 'win32' ? 'launch.cmd' : 'launch'), existing: true, repaired };
  }
  const tools = await discoverSourceTools(undefined, signal);
  let release;
  if (checkout || commit) {
    if (!checkout || !SHA.test(commit)) throw sourceError('INVALID_SOURCE_RELEASE', '--checkout requires --commit with the complete pinned commit SHA.');
    checkout = await fs.realpath(checkout);
    await assertCleanSource(checkout, tools, signal);
    const metadata = await readSourceJSON(path.join(checkout, 'package.json'));
    release = { version: metadata.version, tag: `v${metadata.version}`, commit, checkout, provenance: 'local-candidate', releaseUrl: `${REPOSITORY}/releases` };
  } else release = await resolveOfficialSource({ fetchImpl, signal });
  if (profile && (!path.isAbsolute(profile) || /[\0\r\n]/.test(profile))) throw sourceError('INVALID_SOURCE_PATH', 'The profile path must be absolute.');
  if (profile) {
    await fs.mkdir(profile, { recursive: true, mode: 0o700 });
    profile = await fs.realpath(profile);
    await assertSourceDirectory(profile);
  }
  const receipt = await buildSourceVersion({ root, release, tools, signal, onProgress });
  await fs.copyFile(path.join(receipt.sourceRoot, 'src', 'source-launcher.mjs'), path.join(root, 'launch.mjs'), fs.constants.COPYFILE_EXCL);
  await fs.chmod(path.join(root, 'launch.mjs'), 0o700);
  const bootstrapId = randomBytes(16).toString('hex');
  await writeSourceJSON(path.join(root, 'current.json'), { schema: 1, sourceRoot: receipt.sourceRoot, version: receipt.version, bootstrapId, ...(profile ? { userData: profile } : {}) });
  await writeSourceLauncher(root, tools);
  if (!noLaunch) {
    const child = spawn(tools.node, [path.join(root, 'launch.mjs')], { detached: true, env: sourceEnvironment(tools), stdio: 'ignore' });
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); }); child.unref();
    onProgress('Waiting for the source app to confirm real startup');
    const deadline = Date.now() + 120000;
    for (;;) {
      abort(signal);
      let ready;
      try { ready = await readSourceJSON(path.join(root, 'initial-ready.json')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (ready?.id === bootstrapId && ready.sourceRoot === receipt.sourceRoot && ready.version === receipt.version && Number.isSafeInteger(ready.pid) && ready.pid > 0 && (!profile || ready.userData === profile)) break;
      if (Date.now() >= deadline) throw sourceError('SOURCE_STARTUP_UNCONFIRMED', 'The source app did not confirm startup. The built source and stable launcher are retained; no existing profile was changed by the installer.');
      await new Promise(resolve => setTimeout(resolve, 200));
    }
  }
  return { root, sourceRoot: receipt.sourceRoot, version: receipt.version, commit: receipt.commit, launcher: path.join(root, process.platform === 'win32' ? 'launch.cmd' : 'launch') };
  } finally { await lock.close(); await fs.unlink(lockFile); }
}

export function parseSourceArguments(args) {
  const options = {};
  const names = new Map([['--root', 'root'], ['--checkout', 'checkout'], ['--commit', 'commit'], ['--profile', 'profile']]);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--no-launch') { options.noLaunch = true; continue; }
    const name = names.get(args[i]);
    if (!name || !args[i + 1] || args[i + 1].startsWith('--') || options[name]) throw sourceError('INVALID_ARGUMENT', `Unknown or incomplete source installer option: ${args[i]}`);
    options[name] = args[++i];
  }
  return options;
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const controller = new AbortController();
  process.once('SIGINT', () => controller.abort(sourceError('CANCELLED', 'Source installation cancelled.')));
  process.once('SIGTERM', () => controller.abort(sourceError('CANCELLED', 'Source installation cancelled.')));
  try {
    const result = await installSource({ ...parseSourceArguments(process.argv.slice(2)), signal: controller.signal });
    console.log(`${result.existing ? (result.repaired ? 'Repaired launcher for' : 'Using existing managed source version') : 'Built from source:'} ${result.version}. Stable launcher: ${result.launcher}`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
