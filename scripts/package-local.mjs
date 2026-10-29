import { build, Platform, Arch } from 'electron-builder';

const platform = process.platform;
if (!((platform === 'darwin' && process.arch === 'arm64') || (['win32', 'linux'].includes(platform) && process.arch === 'x64'))) {
  throw new Error('Local packaging supports macOS arm64, Windows x64 and Linux x64.');
}
// Null replaces the root protocol list instead of merging with it. Local
// bundles never register the production account callback on any platform.
process.env.CSC_IDENTITY_AUTO_DISCOVERY = 'false';
await build({
  targets: (platform === 'darwin' ? Platform.MAC : platform === 'win32' ? Platform.WINDOWS : Platform.LINUX).createTarget(['dir'], platform === 'darwin' ? Arch.arm64 : Arch.x64),
  publish: 'never',
  config: {
    directories: { output: 'dist/local' },
    protocols: null,
    mac: { identity: '-', notarize: false },
    extraMetadata: { localProduct: true },
  },
});
