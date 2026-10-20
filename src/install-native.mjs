import { mkdir, writeFile, chmod } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { privateDirectory } from './vault.mjs';
import { BROWSER_IDENTITIES } from './browser-identity.mjs';
export const EXTENSION_ID = BROWSER_IDENTITIES.production.extensionId;
export async function installNative({ executable, appPath, directory, packaged, localOnly, localOrigin }) {
  if (!['darwin', 'linux'].includes(process.platform)) throw new Error('Native messaging installation is supported on macOS and Linux.');
  const identity = localOnly ? BROWSER_IDENTITIES.local : BROWSER_IDENTITIES.production;
  await privateDirectory(directory);
  const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
  const launcher = path.join(directory, 'recruiters-native-host');
  const hostScript = path.join(packaged ? appPath.replace(/app\.asar$/, 'app.asar.unpacked') : appPath, 'src', 'native-host.cjs');
  const configPath = path.join(directory, 'native-config.json');
  await writeFile(configPath, JSON.stringify({ executable, appPath, directory, packaged, localOnly, localOrigin: localOnly ? localOrigin : undefined }), { mode: 0o600 });
  await chmod(configPath, 0o600);
  await writeFile(launcher, `#!/bin/sh\nexec env ELECTRON_RUN_AS_NODE=1 ${quote(executable)} ${quote(hostScript)} ${quote(configPath)} "$@"\n`, { mode: 0o700 });
  await chmod(launcher, 0o700);
  const manifest = JSON.stringify({ name: identity.nativeHost, description: 'Recruiters.rip local job and application companion', path: launcher, type: 'stdio', allowed_origins: [`chrome-extension://${identity.extensionId}/`] }, null, 2);
  const roots = process.platform === 'darwin' ? ['Google/Chrome', 'Chromium', 'BraveSoftware/Brave-Browser', 'Microsoft Edge'].map(browser => path.join(os.homedir(), 'Library/Application Support', browser, 'NativeMessagingHosts')) : ['google-chrome', 'chromium', 'BraveSoftware/Brave-Browser', 'microsoft-edge'].map(browser => path.join(os.homedir(), '.config', browser, 'NativeMessagingHosts'));
  for (const root of roots) {
    await mkdir(root, { recursive: true, mode: 0o700 });
    await writeFile(path.join(root, `${identity.nativeHost}.json`), manifest, { mode: 0o600 });
  }
  return { installed: true, extensionId: identity.extensionId };
}
