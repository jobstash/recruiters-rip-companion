import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import AdmZip from 'adm-zip';
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

for (const local of [false, true]) test(`${local ? 'local' : 'production'} MCPB contains a self-contained cross-platform launcher and isolated invocation`, async () => {
  const archive = new AdmZip(fileURLToPath(new URL(`../src/generated/recruiters-rip${local ? '-local' : ''}.mcpb`, import.meta.url)));
  const manifest = JSON.parse(archive.readAsText('manifest.json'));
  assert.deepEqual(manifest.compatibility.platforms, ['darwin', 'win32', 'linux']);
  assert.equal(manifest.compatibility.runtimes.node, '>=22.12.0');
  assert.equal(manifest.server.entry_point, 'server/index.cjs');
  assert.deepEqual(manifest.server.mcp_config.args, ['${__dirname}/server/index.cjs', ...(local ? ['--local-product'] : [])]);
  assert.equal(archive.readAsText('server/index.cjs'), await readFile(new URL('../src/mcp/local-runner.cjs', import.meta.url), 'utf8'));
  assert.equal(archive.readAsText('platform-runtime.cjs'), await readFile(new URL('../src/platform-runtime.cjs', import.meta.url), 'utf8'));
  assert.ok(archive.getEntry('skills/recruiters-rip/SKILL.md'));
  assert.ok(archive.getEntries().every(entry => !entry.entryName.includes('..') && !entry.entryName.includes('\\')));
});
