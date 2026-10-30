'use strict';
const path = require('node:path');
const { realpathSync } = require('node:fs');
const { spawn } = require('node:child_process');
const { endpoint, restrictedEnvironment, assertPrivatePath, privateJSON, connectAuthenticated } = require('./platform-runtime.cjs');
const MAX_INPUT = 1024 * 1024 + 65536;
const MAX_OUTPUT = 1024 * 1024 - 1024;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
(async () => {
  const selected = process.argv[2];
  if (typeof selected !== 'string' || !path.isAbsolute(selected)) throw new Error('Invalid native configuration path.');
  assertPrivatePath(selected);
  const configPath = realpathSync(selected), config = privateJSON(configPath);
  if (!config || typeof config.localOnly !== 'boolean' || typeof config.packaged !== 'boolean' ||
      !['executable', 'appPath', 'directory', 'userData'].every(key => typeof config[key] === 'string' && path.isAbsolute(config[key])) ||
      config.directory !== realpathSync(config.directory) || config.userData !== realpathSync(config.userData) ||
      config.directory !== path.join(config.userData, config.localOnly ? 'local-device' : 'device') ||
      configPath !== path.join(config.directory, 'native-config.json')) throw new Error('Invalid native configuration.');
  if (config.firefoxManifest !== undefined && (typeof config.firefoxManifest !== 'string' || !path.isAbsolute(config.firefoxManifest))) throw new Error('Invalid Firefox manifest path.');
  const { BROWSER_IDENTITIES, nativeInvocationIdentity } = await import('./browser-identity.mjs');
  const identity = config.localOnly ? BROWSER_IDENTITIES.local : BROWSER_IDENTITIES.production;
  const origin = nativeInvocationIdentity(identity, process.argv.slice(3), { firefoxManifest: config.firefoxManifest });
  assertPrivatePath(config.directory, { directory: true });
  let socket;
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      const bridge = privateJSON(path.join(config.directory, 'bridge.json'));
      if (bridge.socket !== endpoint(config.directory, 'native') || !/^[a-f0-9]{64}$/.test(bridge.token)) throw new Error('Invalid native connection.');
      if (process.platform !== 'win32') assertPrivatePath(path.dirname(bridge.socket), { directory: true });
      socket = await connectAuthenticated(bridge.socket, bridge.token, 'native', { origin });
      break;
    } catch {
      if (attempt === 0) {
        // The harness owns model authentication; do not inherit its API/session keys.
        const env = restrictedEnvironment();
        if (config.localOnly && typeof config.localOrigin === 'string') env.BROWSER_APPLICATION_LOCAL_ORIGIN = config.localOrigin;
        const args = [...(config.packaged ? [] : [config.appPath]), `--user-data-dir=${config.userData}`, '--bridge', ...(config.localOnly ? ['--local-product'] : [])];
        const child = spawn(config.executable, args, { detached: true, stdio: 'ignore', env }); child.on('error', () => {}); child.unref();
      }
      await sleep(250);
    }
  }
  if (!socket) process.exit(1);
  socket.on('error', () => process.exit(1));
  socket.on('end', () => process.exit(0));
  let incoming = Buffer.alloc(0);
  socket.on('data', chunk => {
    incoming = Buffer.concat([incoming, chunk]);
    while (incoming.length >= 4) {
      const length = incoming.readUInt32LE(0);
      if (!length || length > MAX_OUTPUT) process.exit(1);
      if (incoming.length < length + 4) break;
      process.stdout.write(incoming.subarray(0, length + 4)); incoming = incoming.subarray(length + 4);
    }
  });
  socket.resume();
  let input = Buffer.alloc(0);
  process.stdin.on('data', chunk => {
    input = Buffer.concat([input, chunk]);
    while (input.length >= 4) {
      const length = input.readUInt32LE(0);
      if (!length || length > MAX_INPUT) process.exit(1);
      if (input.length < length + 4) break;
      socket.write(input.subarray(0, length + 4)); input = input.subarray(length + 4);
    }
  });
  process.stdin.on('end', () => socket.end());
})().catch(() => process.exit(1));
