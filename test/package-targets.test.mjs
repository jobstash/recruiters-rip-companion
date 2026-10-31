import test from 'node:test';
import assert from 'node:assert/strict';
import { releaseBuildOptions } from '../src/package-release.mjs';

for (const [platform, arch, target, output] of [['darwin', 'arm64', 'zip', 'adhoc'], ['win32', 'x64', 'nsis', 'windows'], ['linux', 'x64', 'AppImage', 'linux']]) {
  test(`${platform} builds native ${arch} installers without publishing or requiring unsigned-build credentials`, () => {
    const options = releaseBuildOptions({ platform, arch, unsigned: true, env: {} });
    assert.equal(options.publish, 'never');
    assert.equal(options.config.directories.output, `dist/${output}`);
    assert.equal(options.config.extraMetadata.localProduct, false);
    assert.equal(options.config.forceCodeSigning, false);
    const targets = [...options.targets.values()].flatMap(arches => [...arches.values()].flat());
    assert.ok(targets.includes(target));
    if (platform === 'darwin') {
      assert.ok(targets.includes('dmg'));
      assert.equal(options.config.mac.notarize, false);
      assert.equal(options.config.mac.identity, '-');
    }
  });
}

test('unsupported build architectures are rejected and notarized macOS releases still require credentials', () => {
  for (const [platform, arch] of [['darwin', 'x64'], ['win32', 'arm64'], ['linux', 'arm64'], ['freebsd', 'x64']]) {
    assert.throws(() => releaseBuildOptions({ platform, arch, unsigned: true, env: {} }), /supported target/);
  }
  assert.throws(() => releaseBuildOptions({ platform: 'darwin', arch: 'arm64', env: {} }), /notarization credentials/);
});
