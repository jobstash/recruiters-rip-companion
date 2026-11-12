import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { browserSetupScript, containerSettings } from '../src/container-cli.mjs';
import { BROWSER_IDENTITIES } from '../src/browser-identity.mjs';
import { agentSetupPrompt } from '../src/host-setup.mjs';
import { nativeInvocationIdentity } from '../src/browser-identity.mjs';

const run = promisify(execFile);
const identity = BROWSER_IDENTITIES.production;
const posix = { skip: process.platform === 'win32' ? 'The browser setup script is for macOS and Linux hosts.' : false, timeout: 20000 };
const containerManifest = '/home/node/.mozilla/native-messaging-hosts/com.recruiters.companion.json';
const settings = browser => ({ browser, container: 'recruiters-companion', version: '9.8.7', launcher: '/data/device/recruiters-native-host',
  firefoxManifest: containerManifest, extension: `/app/browser-extension/dist/${browser === 'firefox' ? 'firefox-production' : 'production'}` });

// A host with a home folder whose name needs quoting, and a `docker` that records its calls and "copies" a synthetic extension.
async function host(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'recruiters-container-host-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = path.join(root, "Zoë's home"), bin = path.join(root, 'bin'), calls = path.join(root, 'docker-calls');
  await mkdir(home); await mkdir(bin);
  await writeFile(path.join(bin, 'docker'), `#!/bin/sh
{ printf '%s' "$#"; for arg in "$@"; do printf '\\t%s' "$arg"; done; printf '\\n'; } >> ${JSON.stringify(calls)}
if [ "$1" = cp ]; then mkdir -p "$3" && printf '{"version":"9.8.7"}' > "$3/manifest.json" && printf 'synthetic' > "$3/background.mjs"; fi
`, { mode: 0o755 });
  await chmod(path.join(bin, 'docker'), 0o755);
  const env = { HOME: home, PATH: `${bin}:/usr/bin:/bin` };
  const setup = browser => run('/bin/sh', ['-c', browserSetupScript(settings(browser))], { env });
  const dockerCalls = async () => (await readFile(calls, 'utf8')).trim().split('\n').map(line => line.split('\t').slice(1));
  const darwin = process.platform === 'darwin';
  const manifests = {
    chrome: (darwin ? ['Google/Chrome', 'Chromium', 'BraveSoftware/Brave-Browser', 'Microsoft Edge'].map(name => path.join(home, 'Library', 'Application Support', name))
      : ['google-chrome', 'chromium', 'BraveSoftware/Brave-Browser', 'microsoft-edge'].map(name => path.join(home, '.config', name)))
      .map(folder => path.join(folder, 'NativeMessagingHosts', `${identity.nativeHost}.json`)),
    firefox: [path.join(home, ...(darwin ? ['Library', 'Application Support', 'Mozilla', 'NativeMessagingHosts'] : ['.mozilla', 'native-messaging-hosts']), `${identity.nativeHost}.json`)],
  };
  return { home, env, setup, dockerCalls, manifests, launcher: path.join(home, '.recruiters-companion', 'recruiters-companion', 'native-host'), bin };
}

test('the browser setup saves the extension and points each browser at a launcher that reaches the container', posix, async t => {
  const f = await host(t);
  const { stdout } = await f.setup('chrome');
  assert.match(stdout, /Chrome can now reach the Companion container recruiters-companion/);
  const folder = path.join(f.home, 'Downloads', 'Recruiters.rip Chrome extension');
  assert.deepEqual((await readdir(folder)).sort(), ['background.mjs', 'managed-update.json', 'manifest.json']);
  // The same marker a folder saved by the desktop app carries: the extension reloads itself when the folder is refreshed.
  assert.deepEqual(JSON.parse(await readFile(path.join(folder, 'managed-update.json'), 'utf8')), { version: '9.8.7' });
  assert.deepEqual((await f.dockerCalls()).find(call => call[0] === 'cp').slice(0, 2), ['cp', 'recruiters-companion:/app/browser-extension/dist/production/.']);
  for (const filename of f.manifests.chrome) {
    assert.deepEqual(JSON.parse(await readFile(filename, 'utf8')), { name: identity.nativeHost, description: 'Recruiters.rip local job and application companion',
      path: f.launcher, type: 'stdio', allowed_origins: [`chrome-extension://${identity.extensionId}/`] });
    assert.equal((await lstat(filename)).mode & 0o777, 0o600);
  }
  assert.equal((await lstat(f.launcher)).mode & 0o777, 0o700);
  await assert.rejects(lstat(f.manifests.firefox[0]), { code: 'ENOENT' }, 'Setting up Chrome leaves Firefox alone');

  // Chrome starts the launcher with the extension's origin; the container's launcher receives exactly that.
  const origin = `chrome-extension://${identity.extensionId}/`;
  await run(f.launcher, [origin], { env: { PATH: '/usr/bin:/bin' } });
  assert.deepEqual((await f.dockerCalls()).at(-1), ['exec', '-i', 'recruiters-companion', '/data/device/recruiters-native-host', origin]);
});

test('Firefox’s own settings-file argument is replaced by the path the container knows, for either setup order', posix, async t => {
  const f = await host(t);
  await f.setup('firefox');
  await f.setup('chrome');
  const [manifest] = f.manifests.firefox;
  assert.deepEqual(JSON.parse(await readFile(manifest, 'utf8')).allowed_extensions, [identity.firefoxExtensionId]);
  await run(f.launcher, [manifest, identity.firefoxExtensionId], { env: { PATH: '/usr/bin:/bin' } });
  const received = (await f.dockerCalls()).at(-1).slice(4);
  assert.deepEqual(received, [containerManifest, identity.firefoxExtensionId]);
  assert.equal(nativeInvocationIdentity(identity, received, { firefoxManifest: containerManifest, platform: 'linux' }), identity.firefoxExtensionId,
    'The helper inside the container accepts what the launcher forwards');
  // Any other first argument is forwarded untouched, so the container still refuses it.
  await run(f.launcher, ['/somewhere/else.json', identity.firefoxExtensionId], { env: { PATH: '/usr/bin:/bin' } });
  assert.deepEqual((await f.dockerCalls()).at(-1).slice(4), ['/somewhere/else.json', identity.firefoxExtensionId]);
});

test('the browser setup replaces only a folder it saved, and stops when the container or Docker is missing', posix, async t => {
  const f = await host(t);
  const folder = path.join(f.home, 'Downloads', 'Recruiters.rip Chrome extension');
  await mkdir(folder, { recursive: true });
  await writeFile(path.join(folder, 'mine.txt'), 'not Companion’s');
  await assert.rejects(f.setup('chrome'), error => /folder that Companion did not create/.test(error.stderr));
  assert.equal(await readFile(path.join(folder, 'mine.txt'), 'utf8'), 'not Companion’s');
  await assert.rejects(lstat(f.launcher), { code: 'ENOENT' });
  await rm(folder, { recursive: true });
  await f.setup('chrome');
  await writeFile(path.join(folder, 'stale.mjs'), 'left by an older version');
  await f.setup('chrome');
  assert.equal((await readdir(folder)).includes('stale.mjs'), false, 'A refreshed folder holds only the current extension');
  assert.deepEqual((await readdir(path.join(f.home, 'Downloads'))), ['Recruiters.rip Chrome extension'], 'No staging folder is left behind');

  await writeFile(path.join(f.bin, 'docker'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  await assert.rejects(f.setup('chrome'), error => /container recruiters-companion is not running/.test(error.stderr));
  // A PATH with no docker at all (CI runners have a real one in /usr/bin).
  await assert.rejects(run('/bin/sh', ['-c', browserSetupScript(settings('chrome'))], { env: { HOME: f.home, PATH: path.join(f.home, 'Downloads') } }),
    error => /Docker is not available/.test(error.stderr));
});

test('container settings accept only a Docker container name, an absolute data folder and a usable port', () => {
  assert.deepEqual(containerSettings({ RECRUITERS_COMPANION_CONTAINER: 'recruiters-companion', RECRUITERS_COMPANION_DATA: '/data', RECRUITERS_COMPANION_WEB_PORT: '45000' }),
    { container: 'recruiters-companion', data: '/data', port: 45000 });
  assert.deepEqual(containerSettings({ RECRUITERS_COMPANION_CONTAINER: 'x; rm -rf ~', RECRUITERS_COMPANION_DATA: 'relative', RECRUITERS_COMPANION_WEB_PORT: '80' }),
    { container: null, data: null, port: 43117 });
  assert.throws(() => browserSetupScript({ ...settings('chrome'), launcher: '/data/device/host\n; rm -rf ~' }), /Invalid browser setup values/);
  assert.throws(() => browserSetupScript({ ...settings('chrome'), browser: 'safari' }));
});

test('the container setup prompt starts the tools through docker exec for every app', () => {
  const prompt = agentSetupPrompt('/data/device/recruiters-rip-mcp', { container: 'recruiters-companion', platform: 'linux' });
  const line = 'docker exec -i recruiters-companion /data/device/recruiters-rip-mcp';
  assert.ok(prompt.includes(`codex mcp add recruiters-rip -- ${line}`));
  assert.ok(prompt.includes(`claude mcp add --scope user recruiters-rip -- ${line}`));
  assert.ok(prompt.includes('[mcp_servers.recruiters-rip]\ncommand = "docker"\nargs = ["exec","-i","recruiters-companion","/data/device/recruiters-rip-mcp"]'));
  assert.deepEqual(JSON.parse(`{${prompt.split('\n').find(entry => entry.startsWith('"recruiters-rip": '))}}`),
    { 'recruiters-rip': { command: 'docker', args: ['exec', '-i', 'recruiters-companion', '/data/device/recruiters-rip-mcp'] } });
  // The host's system is unknown from inside the container, so no single Claude Desktop location is claimed.
  for (const location of ['~/Library/Application Support/Claude', '%APPDATA%\\Claude', '~/.config/Claude']) assert.ok(prompt.includes(location));
  assert.ok(agentSetupPrompt("/data/it's here/mcp", { container: 'c' }).includes(`claude mcp add --scope user recruiters-rip -- docker exec -i c '/data/it'\\''s here/mcp'`));
});
