'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createHash, createHmac, randomBytes, timingSafeEqual } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const net = require('node:net');

const environmentKeys = ['PATH', 'HOME', 'TMPDIR', 'CODEX_HOME', 'XDG_CONFIG_HOME', 'DISPLAY', 'WAYLAND_DISPLAY', 'DBUS_SESSION_BUS_ADDRESS', 'XDG_RUNTIME_DIR', 'XAUTHORITY', 'LANG', 'LC_ALL'];
const windowsKeys = ['SYSTEMROOT', 'WINDIR', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'COMSPEC', 'PATHEXT', 'PROGRAMFILES', 'PROGRAMFILES(X86)', 'PROGRAMW6432'];
function restrictedEnvironment(env = process.env, platform = process.platform) {
  const allowed = new Set([...environmentKeys, ...(platform === 'win32' ? windowsKeys : [])]);
  return Object.fromEntries(Object.entries(env).filter(([key, value]) =>
    (allowed.has(platform === 'win32' ? key.toUpperCase() : key) && typeof value === 'string' && value.length > 0) ||
    (platform === 'linux' && key === 'APPIMAGE_EXTRACT_AND_RUN' && value === '1')));
}
function supportDirectory({ platform = process.platform, env = process.env, home = os.homedir() } = {}) {
  const paths = platform === 'win32' ? path.win32 : path.posix;
  if (platform === 'darwin') return paths.join(home, 'Library', 'Application Support');
  if (platform === 'win32') return env.APPDATA || paths.join(home, 'AppData', 'Roaming');
  return env.XDG_CONFIG_HOME || paths.join(home, '.config');
}
function deviceDirectory({ localOnly = false, platform = process.platform, ...options } = {}) {
  return (platform === 'win32' ? path.win32 : path.posix).join(supportDirectory({ ...options, platform }), 'Recruiters Companion', localOnly ? 'local-device' : 'device');
}
function endpoint(directory, channel, platform = process.platform) {
  if (!['native', 'mcp', 'instance'].includes(channel)) throw new Error('Invalid local transport channel.');
  const normalized = platform === 'win32' ? path.win32.resolve(directory).toLowerCase() : path.posix.resolve(directory);
  const digest = createHash('sha256').update(normalized).digest('hex').slice(0, 32);
  if (platform === 'win32') return `\\\\.\\pipe\\recruiters-companion-${digest}-${channel}`;
  if (channel === 'instance') return `\0recruiters-companion-${digest}`;
  // sockaddr_un includes the terminating NUL (104 bytes on macOS, 108 on Linux).
  // Electron canonicalizes /tmp to /private/tmp; clients must agree on aliases.
  let canonical;
  try { canonical = fs.realpathSync(directory); } catch (error) { if (error.code !== 'ENOENT') throw error; canonical = normalized; }
  const socket = path.posix.join(canonical, `${channel}.sock`);
  if (Buffer.byteLength(socket) < (platform === 'darwin' ? 104 : 108)) return socket;
  const identity = createHash('sha256').update(canonical).digest('hex').slice(0, 32);
  return path.posix.join('/tmp', `recruiters-companion-${process.getuid()}-${identity}`, `${channel}.sock`);
}
function mcpCommand(directory, platform = process.platform) {
  return (platform === 'win32' ? path.win32 : path).join(directory, `recruiters-rip-mcp${platform === 'win32' ? '.cmd' : ''}`);
}
function launcherScript({ executable, script, args = [], forwardArgs = false, platform = process.platform }) {
  const values = [executable, script, ...args];
  if (values.some(value => typeof value !== 'string' || /[\0\r\n]/.test(value))) throw new Error('Invalid launcher argument.');
  if (platform === 'win32') {
    const quote = value => {
      if (value.includes('"')) throw new Error('Invalid Windows launcher argument.');
      return `"${value.replaceAll('%', '%%')}"`;
    };
    // Clear inherited model credentials and Node injection options before starting Electron/Node.
    const keep = [...environmentKeys, ...windowsKeys].map(key => `if /i not "%%V"=="${key}"`).join(' ');
    return `@echo off\r\nsetlocal DisableDelayedExpansion\r\nfor /f "tokens=1 delims==" %%V in ('set') do ${keep} set "%%V="\r\nset "ELECTRON_RUN_AS_NODE=1"\r\n${values.map(quote).join(' ')}${forwardArgs ? ' %*' : ''}\r\nexit /b %errorlevel%\r\n`;
  }
  const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
  const env = environmentKeys.map(key => `\${${key}:+"${key}=$${key}"}`).join(' ');
  const extraction = platform === 'linux' ? 'appimage_mode=\nif [ "${APPIMAGE_EXTRACT_AND_RUN-}" = 1 ]; then appimage_mode=APPIMAGE_EXTRACT_AND_RUN=1; fi\n' : '';
  return `#!/bin/sh\n${extraction}exec /usr/bin/env -i ${env}${platform === 'linux' ? ' $appimage_mode' : ''} ELECTRON_RUN_AS_NODE=1 ${values.map(quote).join(' ')}${forwardArgs ? ' "$@"' : ''}\n`;
}

// Windows mode bits do not represent privacy. Inspect/enforce the actual NTFS DACL,
// allowing only this account and the OS administrators/SYSTEM. Never accept an
// owner outside those principals, symbolic link/junction, public ACE, or a filesystem without ACLs.
function windowsAcl(filename, protect, directory, { env = process.env, run = execFileSync } = {}) {
  const root = env.SYSTEMROOT || env.SystemRoot;
  if (!root || !path.win32.isAbsolute(root)) throw new Error('Windows system directory is unavailable.');
  const target = Buffer.from(filename, 'utf8').toString('base64');
  // Use .NET ACL APIs directly: Get-Acl/Set-Acl trigger PowerShell module
  // discovery, which can hang or load incompatible modules from a host shell.
  const kind = directory ? 'Directory' : 'File';
  // Elevated tokens can create Administrators-owned objects. These OS principals
  // already have full DACL access; arbitrary other user/group owners remain invalid.
  const script = `$ErrorActionPreference='Stop';$p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${target}'));$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User;$allowed=@($sid.Value,'S-1-5-18','S-1-5-32-544');$a=[IO.${kind}]::GetAccessControl($p);if($a.GetOwner([Security.Principal.SecurityIdentifier]).Value -notin $allowed){throw 'Foreign owner'};` +
    (protect ? `$a.SetAccessRuleProtection($true,$false);foreach($r in @($a.Access)){$a.RemoveAccessRuleSpecific($r)};$inherit=[Security.AccessControl.InheritanceFlags]::${directory ? 'ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit' : 'None'};foreach($s in @($sid.Value,'S-1-5-18','S-1-5-32-544')){$r=[Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($s),[Security.AccessControl.FileSystemRights]::FullControl,$inherit,[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow);$a.AddAccessRule($r)};[IO.${kind}]::SetAccessControl($p,$a);$a=[IO.${kind}]::GetAccessControl($p);` : '') +
    `$own=$false;foreach($r in $a.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])){if($r.AccessControlType -eq 'Allow'){if($r.IdentityReference.Value -notin $allowed){throw 'Public access'};if($r.IdentityReference.Value -eq $sid.Value){$own=$true}}};if(-not $own){throw 'Missing owner access'}`;
  run(path.win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { env: restrictedEnvironment(env, 'win32'), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], timeout: 15000 });
}
function assertPrivatePath(filename, { directory = false, maxSize = Infinity, platform = process.platform, info = fs.lstatSync(filename), ...options } = {}) {
  if (info.isSymbolicLink() || !(directory ? info.isDirectory() : info.isFile()) || (!directory && info.size > maxSize)) throw new Error('Invalid private storage.');
  if (platform === 'win32') windowsAcl(filename, false, directory, options);
  else if ((process.getuid && info.uid !== process.getuid()) || (info.mode & 0o077)) throw new Error('Invalid private storage permissions.');
  return info;
}
function protectPrivatePath(filename, { directory = false, mode = directory ? 0o700 : 0o600, platform = process.platform, ...options } = {}) {
  const info = fs.lstatSync(filename);
  if (info.isSymbolicLink() || !(directory ? info.isDirectory() : info.isFile()) || (platform !== 'win32' && process.getuid && info.uid !== process.getuid())) throw new Error('Invalid private storage.');
  if (platform === 'win32') windowsAcl(filename, true, directory, options);
  else fs.chmodSync(filename, mode);
}
function privateJSON(filename, options = {}) {
  assertPrivatePath(filename, { maxSize: 16384, ...options });
  return JSON.parse(fs.readFileSync(filename, 'utf8'));
}
function authenticationProof(token, role, channel, clientNonce, serverNonce) {
  if (!['native', 'mcp'].includes(channel) || !['server', 'client'].includes(role) ||
      ![token, clientNonce, serverNonce].every(value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value))) throw new Error('Invalid local authentication.');
  return createHmac('sha256', Buffer.from(token, 'hex')).update(`recruiters-companion-v1\0${role}\0${channel}\0${clientNonce}\0${serverNonce}`).digest('hex');
}
function verifyAuthenticationProof(token, role, channel, challenge, proof) {
  return typeof proof === 'string' && /^[a-f0-9]{64}$/.test(proof) &&
    timingSafeEqual(Buffer.from(proof, 'hex'), Buffer.from(authenticationProof(token, role, channel, challenge.clientNonce, challenge.serverNonce), 'hex'));
}
function createAuthenticationChallenge(token, channel, hello) {
  if (!hello || typeof hello !== 'object' || Array.isArray(hello) || Object.keys(hello).length !== 1 || !/^[a-f0-9]{64}$/.test(hello.hello)) throw new Error('Invalid local handshake.');
  const clientNonce = hello.hello, serverNonce = randomBytes(32).toString('hex');
  return { clientNonce, serverNonce, message: { challenge: serverNonce, proof: authenticationProof(token, 'server', channel, clientNonce, serverNonce) } };
}
function authenticationFrame(channel, value) {
  const body = Buffer.from(JSON.stringify(value));
  if (channel === 'mcp') return Buffer.concat([body, Buffer.from('\n')]);
  const header = Buffer.allocUnsafe(4); header.writeUInt32LE(body.length);
  return Buffer.concat([header, body]);
}
function connectAuthenticated(socketPath, token, channel, { origin, timeout = 5000 } = {}) {
  return new Promise((resolve, reject) => {
    const clientNonce = randomBytes(32).toString('hex'), socket = net.connect(socketPath);
    let input = Buffer.alloc(0);
    const failed = error => { cleanup(); socket.destroy(); reject(error); };
    const closed = () => failed(new Error('Local authentication closed.'));
    const timer = setTimeout(() => failed(new Error('Local authentication timed out.')), timeout);
    const cleanup = () => { clearTimeout(timer); socket.removeListener('error', failed); socket.removeListener('close', closed); socket.removeListener('data', receive); };
    const receive = chunk => {
      try {
        input = Buffer.concat([input, chunk]);
        if (input.length > 4096) throw new Error('Invalid local handshake.');
        const start = channel === 'mcp' ? 0 : 4;
        const length = channel === 'mcp' ? input.indexOf(10) : input.length >= 4 ? input.readUInt32LE(0) : -1;
        if (length > 4092 || (channel !== 'mcp' && length === 0)) throw new Error('Invalid local handshake.');
        if (length < 0 || input.length < start + length) return;
        if (input.length !== start + length + (channel === 'mcp' ? 1 : 0)) throw new Error('Unexpected local handshake data.');
        const message = JSON.parse(input.subarray(start, start + length).toString('utf8'));
        const challenge = { clientNonce, serverNonce: message?.challenge };
        if (!message || typeof message !== 'object' || Object.keys(message).length !== 2 ||
            !verifyAuthenticationProof(token, 'server', channel, challenge, message.proof)) throw new Error('Local server authentication failed.');
        socket.pause(); cleanup();
        socket.write(authenticationFrame(channel, { authProof: authenticationProof(token, 'client', channel, clientNonce, challenge.serverNonce), ...(channel === 'native' ? { origin } : {}) }));
        resolve(socket);
      } catch (error) { failed(error); }
    };
    socket.once('error', failed); socket.once('close', closed); socket.on('data', receive);
    socket.once('connect', () => socket.write(authenticationFrame(channel, { hello: clientNonce })));
  });
}
async function prepareBridgeRuntime({ executable, appPath, directory, packaged, version, platform = process.platform, env = process.env }) {
  const runtimeRoot = packaged ? appPath.replace(/app\.asar$/, 'app.asar.unpacked') : appPath;
  if (platform !== 'linux' || !packaged || !env.APPIMAGE) return { executable, appPath, runtimeRoot };
  if (!path.posix.isAbsolute(env.APPIMAGE) || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)) throw new Error('Invalid AppImage installation.');
  const image = await fs.promises.realpath(env.APPIMAGE);
  if (!(await fs.promises.stat(image)).isFile()) throw new Error('The installed AppImage is unavailable.');
  await fs.promises.access(image, fs.constants.X_OK);
  // The AppImage mount disappears on exit. Only standalone bridge scripts need
  // persistence; the stable AppImage remounts its own Electron in Node mode.
  const base = path.join(directory, 'bridge-runtime'), cached = path.join(base, version);
  for (const entry of [directory, base, cached, path.join(cached, 'src'), path.join(cached, 'src', 'generated')]) {
    await fs.promises.mkdir(entry, { recursive: true, mode: 0o700 });
    protectPrivatePath(entry, { directory: true });
  }
  for (const relative of ['src/native-host.cjs', 'src/browser-identity.mjs', 'src/platform-runtime.cjs', 'src/generated/mcp-host.cjs']) {
    const destination = path.join(cached, relative), temporary = `${destination}.${randomBytes(12).toString('hex')}.tmp`;
    const bytes = await fs.promises.readFile(path.join(runtimeRoot, relative));
    try {
      await fs.promises.writeFile(temporary, bytes, { mode: 0o600, flag: 'wx' });
      await fs.promises.rename(temporary, destination);
    } finally { await fs.promises.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
  }
  return { executable: image, appPath: cached, runtimeRoot: cached };
}
async function persistBrowserExtension({ source, directory, browser, packaged, platform = process.platform, env = process.env, rename = fs.promises.rename }) {
  if (platform !== 'linux' || !packaged || !env.APPIMAGE) return source;
  if (!['chrome', 'firefox'].includes(browser) || !path.posix.isAbsolute(env.APPIMAGE)) throw new Error('Invalid browser extension installation.');
  const base = path.join(directory, 'browser-extensions'), destination = path.join(base, browser);
  for (const entry of [directory, base]) {
    await fs.promises.mkdir(entry, { recursive: true, mode: 0o700 });
    protectPrivatePath(entry, { directory: true });
  }
  let existing = false;
  try { assertPrivatePath(destination, { directory: true }); existing = true; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const nonce = randomBytes(12).toString('hex'), staged = path.join(base, `.${browser}-${nonce}.tmp`), backup = path.join(base, `.${browser}-${nonce}.previous`);
  async function copyTree(from, to) {
    const info = await fs.promises.lstat(from);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Invalid bundled extension directory.');
    await fs.promises.mkdir(to, { mode: 0o700 });
    for (const entry of await fs.promises.readdir(from, { withFileTypes: true })) {
      const input = path.join(from, entry.name), output = path.join(to, entry.name);
      if (entry.isSymbolicLink()) throw new Error('Bundled extensions cannot contain symbolic links.');
      if (entry.isDirectory()) await copyTree(input, output);
      else if (entry.isFile()) { await fs.promises.copyFile(input, output, fs.constants.COPYFILE_EXCL); await fs.promises.chmod(output, 0o600); }
      else throw new Error('Invalid bundled extension file.');
    }
  }
  let moved = false, installed = false;
  try {
    await copyTree(source, staged);
    if (existing) { await rename(destination, backup); moved = true; }
    try { await rename(staged, destination); installed = true; }
    catch (error) { if (moved) await rename(backup, destination); throw error; }
    return destination;
  } finally {
    await fs.promises.rm(staged, { recursive: true, force: true });
    if (installed && moved) await fs.promises.rm(backup, { recursive: true, force: true });
  }
}
module.exports = { restrictedEnvironment, supportDirectory, deviceDirectory, endpoint, mcpCommand, launcherScript, assertPrivatePath, protectPrivatePath, privateJSON,
  createAuthenticationChallenge, verifyAuthenticationProof, connectAuthenticated, prepareBridgeRuntime, persistBrowserExtension };
