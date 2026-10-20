import { build, Platform, Arch } from 'electron-builder';

// A local-origin bundle must not claim the production account URL scheme.
await build({
  targets: Platform.MAC.createTarget(['dir'], Arch.arm64),
  publish: 'never',
  config: {
    directories: { output: 'dist/local' },
    protocols: [],
    mac: { identity: '-', notarize: false },
    extraMetadata: { localProduct: true },
  },
});
