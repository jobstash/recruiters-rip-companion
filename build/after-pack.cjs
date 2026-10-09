'use strict';
const { access, realpath, stat } = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');

module.exports = async function afterPack(context) {
  if (!['darwin', 'linux'].includes(context.electronPlatformName)) throw new Error('Local MCP packaging currently supports macOS and Linux.');
  const resources = context.packager.getResourcesDir(context.appOutDir);
  const unpacked = await realpath(path.join(resources, 'app.asar.unpacked'));
  for (const relative of ['src/native-host.cjs', 'src/generated/mcp-host.cjs']) {
    const file = await realpath(path.join(unpacked, relative));
    if (!file.startsWith(`${unpacked}${path.sep}`) || !(await stat(file)).isFile()) throw new Error(`Missing packaged local bridge: ${relative}`);
    await access(file, constants.R_OK);
  }
  if (!(await stat(path.join(resources, 'app.asar'))).isFile()) throw new Error('The packaged local tool runtime is missing.');
};
