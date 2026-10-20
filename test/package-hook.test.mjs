import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import afterPack from '../scripts/after-pack.cjs';

const run = promisify(execFile);
for (const localProduct of [true, false]) test(`packaged ${localProduct ? 'local' : 'production'} bundle keeps the correct URL-handler boundary`, { skip: process.platform !== 'darwin' }, async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'recruiters-bundle-protocol-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const contents = path.join(directory, 'Synthetic.app', 'Contents');
  const resources = path.join(contents, 'Resources');
  const unpacked = path.join(resources, 'app.asar.unpacked', 'src');
  await mkdir(path.join(unpacked, 'generated'), { recursive: true });
  await writeFile(path.join(resources, 'app.asar'), 'synthetic packaged runtime');
  await writeFile(path.join(unpacked, 'native-host.cjs'), '');
  await writeFile(path.join(unpacked, 'generated', 'mcp-host.cjs'), '');
  const plist = path.join(contents, 'Info.plist');
  await writeFile(plist, '<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleURLTypes</key><array><dict><key>CFBundleURLSchemes</key><array><string>recruiters-companion</string></array></dict></array></dict></plist>');
  await afterPack({ electronPlatformName: 'darwin', appOutDir: directory,
    packager: { config: { extraMetadata: { localProduct } }, getResourcesDir: () => resources } });
  const { stdout } = await run('/usr/bin/plutil', ['-extract', 'CFBundleURLTypes', 'json', '-o', '-', plist]);
  assert.deepEqual(JSON.parse(stdout), localProduct ? [] : [{ CFBundleURLSchemes: ['recruiters-companion'] }]);
});
