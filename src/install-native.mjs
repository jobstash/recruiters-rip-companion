import { mkdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { privateDirectory } from './vault.mjs';
import { BROWSER_IDENTITIES } from './browser-identity.mjs';
import { launcherScript, protectPrivatePath, restrictedEnvironment, supportDirectory } from './platform-runtime.cjs';
export const EXTENSION_ID = BROWSER_IDENTITIES.production.extensionId;

export function nativeLocations({ directory, identity, platform = process.platform, env = process.env, home = os.homedir() }) {
  const paths = platform === 'win32' ? path.win32 : path.posix;
  if (platform === 'win32') {
    return ['Google\\Chrome', 'Chromium', 'Microsoft\\Edge', 'BraveSoftware\\Brave-Browser', 'Mozilla'].map(browser => ({
      browser: browser === 'Mozilla' ? 'firefox' : 'chrome',
      manifest: paths.join(directory, `${identity.nativeHost}.${browser === 'Mozilla' ? 'firefox' : 'chrome'}.json`),
      registry: `HKCU\\Software\\${browser}\\NativeMessagingHosts\\${identity.nativeHost}`,
    }));
  }
  const roots = platform === 'darwin' ? ['Google/Chrome', 'Chromium', 'BraveSoftware/Brave-Browser', 'Microsoft Edge'] : ['google-chrome', 'chromium', 'BraveSoftware/Brave-Browser', 'microsoft-edge'];
  const locations = roots.map(browser => ({ browser: 'chrome', manifest: paths.join(supportDirectory({ platform, env, home }), browser, 'NativeMessagingHosts', `${identity.nativeHost}.json`) }));
  locations.push({ browser: 'firefox', manifest: paths.join(home, ...(platform === 'darwin' ? ['Library', 'Application Support', 'Mozilla', 'NativeMessagingHosts'] : ['.mozilla', 'native-messaging-hosts']), `${identity.nativeHost}.json`) });
  return locations;
}
export async function installNative({ executable, appPath, directory, packaged, localOnly = false, localOrigin, platform = process.platform, env = process.env, home = os.homedir(), run = promisify(execFile) }) {
  const identity = localOnly ? BROWSER_IDENTITIES.local : BROWSER_IDENTITIES.production;
  const paths = platform === 'win32' ? path.win32 : path;
  await privateDirectory(directory);
  directory = await realpath(directory);
  const userData = await realpath(paths.dirname(directory));
  if (directory !== paths.join(userData, localOnly ? 'local-device' : 'device')) throw new Error('Invalid native profile directory.');
  const launcher = paths.join(directory, `recruiters-native-host${platform === 'win32' ? '.bat' : ''}`);
  const hostScript = paths.join(packaged ? appPath.replace(/app\.asar$/, 'app.asar.unpacked') : appPath, 'src', 'native-host.cjs');
  const configPath = paths.join(directory, 'native-config.json');
  const locations = nativeLocations({ directory, identity, platform, env, home });
  const firefoxManifest = locations.find(location => location.browser === 'firefox').manifest;
  await writeFile(configPath, JSON.stringify({ executable, appPath, directory, userData, packaged, localOnly, firefoxManifest, localOrigin: localOnly ? localOrigin : undefined }), { mode: 0o600 });
  protectPrivatePath(configPath);
  await writeFile(launcher, launcherScript({ executable, script: hostScript, args: [configPath], forwardArgs: true, platform }), { mode: 0o700 });
  protectPrivatePath(launcher, { mode: 0o700 });
  const installed = [];
  for (const location of locations) {
    const manifest = JSON.stringify({ name: identity.nativeHost, description: 'Recruiters.rip local job and application companion', path: launcher, type: 'stdio',
      ...(location.browser === 'firefox' ? { allowed_extensions: [identity.firefoxExtensionId] } : { allowed_origins: [`chrome-extension://${identity.extensionId}/`] }) }, null, 2);
    try {
      await mkdir(paths.dirname(location.manifest), { recursive: true, mode: 0o700 });
      await writeFile(location.manifest, manifest, { mode: 0o600 });
      if (location.registry) {
        const systemRoot = env.SYSTEMROOT || env.SystemRoot;
        if (!systemRoot || !paths.isAbsolute(systemRoot)) throw new Error('Windows registry is unavailable.');
        await run(paths.join(systemRoot, 'System32', 'reg.exe'), ['ADD', location.registry, '/ve', '/t', 'REG_SZ', '/d', location.manifest, '/f', '/reg:64'], { env: restrictedEnvironment(env, platform), windowsHide: true, timeout: 10000 });
      }
      installed.push(location);
    } catch { /* Report only successful registrations; another browser can remain usable. */ }
  }
  return { installed: installed.length > 0, extensionId: identity.extensionId, firefoxExtensionId: identity.firefoxExtensionId,
    browsers: { chrome: installed.some(location => location.browser === 'chrome'), firefox: installed.some(location => location.browser === 'firefox') } };
}
