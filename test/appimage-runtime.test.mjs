import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, copyFile, writeFile, readFile, rm, realpath, readdir, rename, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { prepareBridgeRuntime, persistBrowserExtension, assertPrivatePath, launcherScript, restrictedEnvironment } from '../src/platform-runtime.cjs';
import { installNative } from '../src/install-native.mjs';

const source = fileURLToPath(new URL('../src/', import.meta.url));

test('installed AppImage bridge runtime survives removal of its mounted source tree', { skip: process.platform === 'win32' }, async t => {
  const home = await mkdtemp(path.join(tmpdir(), 'rr-appimage-runtime-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const mount = path.join(home, 'transient mount'), unpacked = path.join(mount, 'resources', 'app.asar.unpacked');
  const files = ['native-host.cjs', 'browser-identity.mjs', 'platform-runtime.cjs', 'generated/mcp-host.cjs'];
  await mkdir(path.join(unpacked, 'src', 'generated'), { recursive: true });
  for (const file of files) await copyFile(path.join(source, file === 'generated/mcp-host.cjs' ? 'mcp/local-runner.cjs' : file), path.join(unpacked, 'src', file));
  // A synthetic executable validates path persistence only. This test does not
  // stand in for executing the actual AppImage runtime or its FUSE remount.
  const image = path.join(home, 'Companion stable.AppImage');
  await writeFile(image, '#!/bin/sh\nexit 99\n', { mode: 0o700 });
  const directory = path.join(home, 'device');
  const runtime = await prepareBridgeRuntime({ executable: path.join(mount, 'companion'), appPath: path.join(mount, 'resources', 'app.asar'), directory, packaged: true, version: '3.10.0', platform: 'linux', env: { APPIMAGE: image } });
  assert.equal(runtime.executable, await realpath(image));
  assert.equal(runtime.appPath, runtime.runtimeRoot);
  assert.equal(runtime.runtimeRoot, path.join(directory, 'bridge-runtime', '3.10.0'));
  assertPrivatePath(runtime.runtimeRoot, { directory: true });
  for (const file of files) {
    const cached = path.join(runtime.runtimeRoot, 'src', file);
    assertPrivatePath(cached);
    assert.deepEqual(await readFile(cached), await readFile(path.join(unpacked, 'src', file)));
  }
  await rm(mount, { recursive: true });
  const installed = await installNative({ executable: runtime.executable, appPath: runtime.appPath, directory, packaged: true, localOnly: false, platform: 'linux', env: { XDG_CONFIG_HOME: path.join(home, 'config') }, home });
  assert.equal(installed.installed, true);
  const config = JSON.parse(await readFile(path.join(directory, 'native-config.json'), 'utf8'));
  assert.equal(config.executable, runtime.executable);
  assert.equal(config.appPath, runtime.appPath);
  const { stdout } = await promisify(execFile)(process.execPath, ['-e', `const r=require(${JSON.stringify(path.join(runtime.runtimeRoot, 'src', 'platform-runtime.cjs'))}); import(${JSON.stringify(pathToFileURL(path.join(runtime.runtimeRoot, 'src', 'browser-identity.mjs')).href)}).then(i=>console.log(JSON.stringify({protocol:typeof r.connectAuthenticated,id:i.BROWSER_IDENTITIES.production.firefoxExtensionId})));`]);
  assert.deepEqual(JSON.parse(stdout), { protocol: 'function', id: 'recruiters-rip@recruiters.rip' });
  const mcpScript = path.join(runtime.runtimeRoot, 'src', 'generated', 'mcp-host.cjs');
  const launcher = launcherScript({ executable: runtime.executable, script: mcpScript, platform: 'linux' });
  assert.equal(launcher.includes(mount), false);
  assert.equal((await readFile(path.join(directory, 'recruiters-native-host'), 'utf8')).includes(mount), false);
});

test('non-AppImage installations retain existing executable and application paths', async () => {
  const base = { executable: '/stable/companion', appPath: '/stable/resources/app.asar', directory: '/unused/device', version: '3.10.0' };
  for (const options of [{ platform: 'darwin', packaged: true, env: { APPIMAGE: '/unused' } }, { platform: 'win32', packaged: true, env: {} }, { platform: 'linux', packaged: false, env: { APPIMAGE: '/unused' } }, { platform: 'linux', packaged: true, env: {} }]) {
    const runtime = await prepareBridgeRuntime({ ...base, ...options });
    assert.equal(runtime.executable, base.executable); assert.equal(runtime.appPath, base.appPath);
    assert.equal(runtime.runtimeRoot, options.packaged ? '/stable/resources/app.asar.unpacked' : base.appPath);
  }
});

test('Linux bridges preserve only explicitly enabled AppImage extraction mode', { skip: process.platform === 'win32' }, async t => {
  const home = await mkdtemp(path.join(tmpdir(), 'rr-appimage-environment-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const script = path.join(home, 'environment.cjs'), launcher = path.join(home, 'launcher');
  await writeFile(script, "process.stdout.write(process.env.APPIMAGE_EXTRACT_AND_RUN ?? 'unset');");
  await writeFile(launcher, launcherScript({ executable: process.execPath, script, platform: 'linux' }), { mode: 0o700 });
  for (const value of ['1', '0', '']) {
    const env = { ...process.env, APPIMAGE_EXTRACT_AND_RUN: value, APPIMAGE: '/stale/image', APPDIR: '/stale/mount', OPENAI_API_KEY: 'synthetic-secret' };
    const sanitized = restrictedEnvironment(env, 'linux');
    assert.equal(sanitized.APPIMAGE_EXTRACT_AND_RUN, value === '1' ? '1' : undefined);
    assert.equal(sanitized.APPIMAGE, undefined); assert.equal(sanitized.APPDIR, undefined); assert.equal(sanitized.OPENAI_API_KEY, undefined);
    const { stdout } = await promisify(execFile)(launcher, [], { env });
    assert.equal(stdout, value === '1' ? '1' : 'unset');
  }
});

test('AppImage extension folders survive mount removal and refresh the same browser path transactionally', { skip: process.platform === 'win32' }, async t => {
  const home = await mkdtemp(path.join(tmpdir(), 'rr-extension-persistence-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const bundled = path.join(home, 'mounted-extension'), directory = path.join(home, 'device');
  const options = { source: bundled, directory, browser: 'chrome', packaged: true, platform: 'linux', env: { APPIMAGE: '/installed/Companion.AppImage' } };
  await mkdir(bundled);
  await writeFile(path.join(bundled, 'manifest.json'), '{"version":"1.0.0"}');
  await writeFile(path.join(bundled, 'obsolete.js'), 'old');
  const persistent = await persistBrowserExtension(options);
  assert.equal(persistent, path.join(directory, 'browser-extensions', 'chrome'));
  const firefox = await persistBrowserExtension({ ...options, browser: 'firefox' });
  assert.equal(firefox, path.join(directory, 'browser-extensions', 'firefox'));
  await rm(bundled, { recursive: true });
  assert.deepEqual(JSON.parse(await readFile(path.join(persistent, 'manifest.json'), 'utf8')), { version: '1.0.0' });
  await mkdir(bundled);
  await writeFile(path.join(bundled, 'manifest.json'), '{"version":"2.0.0"}');
  await writeFile(path.join(bundled, 'current.js'), 'new');
  assert.equal(await persistBrowserExtension(options), persistent);
  assert.deepEqual((await readdir(persistent)).sort(), ['current.js', 'manifest.json']);
  assert.deepEqual(JSON.parse(await readFile(path.join(persistent, 'manifest.json'), 'utf8')), { version: '2.0.0' });
  await writeFile(path.join(bundled, 'manifest.json'), '{"version":"3.0.0"}');
  await assert.rejects(persistBrowserExtension({ ...options, rename: async (from, to) => {
    if (from.endsWith('.tmp') && to === persistent) throw new Error('Synthetic replacement failure');
    return rename(from, to);
  } }), /Synthetic replacement failure/);
  assert.deepEqual(JSON.parse(await readFile(path.join(persistent, 'manifest.json'), 'utf8')), { version: '2.0.0' });
  assert.deepEqual((await readdir(path.dirname(persistent))).sort(), ['chrome', 'firefox']);
  await symlink(path.join(bundled, 'manifest.json'), path.join(bundled, 'unsafe.json'));
  await assert.rejects(persistBrowserExtension(options), /symbolic links/);
  assert.deepEqual(JSON.parse(await readFile(path.join(persistent, 'manifest.json'), 'utf8')), { version: '2.0.0' });
  await rm(path.join(bundled, 'unsafe.json'));
  await rm(persistent, { recursive: true });
  await symlink(bundled, persistent);
  await assert.rejects(persistBrowserExtension(options), /private storage/);
});

test('stable installed and source extension folders are not relocated', async () => {
  const source = '/existing/browser-extension';
  for (const options of [{ platform: 'darwin', packaged: true }, { platform: 'win32', packaged: true }, { platform: 'linux', packaged: false }, { platform: 'linux', packaged: true }])
    assert.equal(await persistBrowserExtension({ source, directory: '/unused', browser: 'chrome', ...options, env: {} }), source);
});
