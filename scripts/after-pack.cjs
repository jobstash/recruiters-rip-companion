'use strict';
const { access, realpath, stat } = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const run = promisify(execFile);

module.exports = async function afterPack(context) {
  if (!['darwin', 'win32', 'linux'].includes(context.electronPlatformName)) throw new Error('Local MCP packaging supports macOS, Windows and Linux.');
  if (context.packager.config.extraMetadata?.localProduct === true) context.packager.config.protocols = [];
  const resources = context.packager.getResourcesDir(context.appOutDir);
  if (context.electronPlatformName === 'darwin' && context.packager.config.extraMetadata?.localProduct === true) {
    // Builder merges the root protocol declaration into local overrides. Clear
    // the generated bundle metadata itself before signing or registration.
    await run('/usr/bin/plutil', ['-replace', 'CFBundleURLTypes', '-json', '[]', path.join(resources, '..', 'Info.plist')]);
  }
  const unpacked = await realpath(path.join(resources, 'app.asar.unpacked'));
  for (const relative of ['src/native-host.cjs', 'src/platform-runtime.cjs', 'src/generated/mcp-host.cjs']) {
    const file = await realpath(path.join(unpacked, relative));
    if (!file.startsWith(`${unpacked}${path.sep}`) || !(await stat(file)).isFile()) throw new Error(`Missing packaged local bridge: ${relative}`);
    await access(file, constants.R_OK);
  }
  if (!(await stat(path.join(resources, 'app.asar'))).isFile()) throw new Error('The packaged local tool runtime is missing.');
};
