import { build, Platform, Arch } from 'electron-builder';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export function releaseBuildOptions({ platform = process.platform, arch = process.arch, unsigned = false, env = process.env } = {}) {
  if (!((platform === 'darwin' && arch === 'arm64') || (['win32', 'linux'].includes(platform) && arch === 'x64'))) {
    throw new Error('Build on macOS arm64, Windows x64 or Linux x64 for the corresponding supported target.');
  }
  if (platform === 'darwin') {
    const certificate = Boolean((env.CSC_LINK && env.CSC_KEY_PASSWORD) || (env.CSC_NAME && env.CSC_NAME !== '-'));
    const notarization = Boolean((env.APPLE_API_KEY && env.APPLE_API_KEY_ID && env.APPLE_API_ISSUER) || (env.APPLE_ID && env.APPLE_APP_SPECIFIC_PASSWORD && env.APPLE_TEAM_ID));
    if (!unsigned && (!certificate || !notarization || env.CSC_NAME === '-')) {
      throw new Error('Release packaging requires a Developer ID Application certificate and Apple notarization credentials. Use package:adhoc for an explicitly unnotarized production-origin build.');
    }
    return { targets: Platform.MAC.createTarget(['zip', 'dmg'], Arch.arm64), publish: 'never', config: {
      directories: { output: unsigned ? 'dist/adhoc' : 'dist/release' }, forceCodeSigning: !unsigned,
      mac: { hardenedRuntime: true, notarize: !unsigned, ...(unsigned ? { identity: '-' } : {}) }, extraMetadata: { localProduct: false },
    } };
  }
  return { targets: (platform === 'win32' ? Platform.WINDOWS : Platform.LINUX).createTarget(platform === 'win32' ? ['nsis'] : ['AppImage'], Arch.x64),
    publish: 'never', config: {
      directories: { output: unsigned ? `dist/${platform === 'win32' ? 'windows' : 'linux'}` : 'dist/release' },
      forceCodeSigning: false, extraMetadata: { localProduct: false },
    } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2);
    if (args.some(arg => !['--unsigned', '--platform=win32', '--platform=linux', '--platform=darwin'].includes(arg))) throw new Error('Unknown packaging option.');
    const platform = args.find(arg => arg.startsWith('--platform='))?.slice('--platform='.length) ?? process.platform;
    if (platform !== process.platform) throw new Error('Package on the target operating system; cross-platform installers are not supported by this command.');
    if (platform !== 'darwin' || args.includes('--unsigned')) process.env.CSC_IDENTITY_AUTO_DISCOVERY = 'false';
    await build(releaseBuildOptions({ platform, unsigned: args.includes('--unsigned') }));
  } catch (error) {
    process.stderr.write(`Packaging failed: ${error.message}\nNo release was published.\n`);
    process.exitCode = 1;
  }
}
