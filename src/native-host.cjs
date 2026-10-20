'use strict';
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const MAX_INPUT = 1024 * 1024 + 65536;
const MAX_OUTPUT = 1024 * 1024 - 1024;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function privateFile(file) {
  const info = fs.lstatSync(file);
  if (!info.isFile() || info.isSymbolicLink() || (process.getuid && info.uid !== process.getuid()) || (info.mode & 0o077)) throw new Error('Invalid bridge storage');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
function frame(value) {
  const body = Buffer.from(JSON.stringify(value));
  if (body.length > MAX_OUTPUT) throw new Error('Response exceeds native transport limit');
  const size = Buffer.allocUnsafe(4); size.writeUInt32LE(body.length); return Buffer.concat([size, body]);
}
(async () => {
  const configPath = process.argv[2];
  const config = privateFile(configPath);
  const { BROWSER_IDENTITIES } = await import('./browser-identity.mjs');
  const identity = config.localOnly === true ? BROWSER_IDENTITIES.local : BROWSER_IDENTITIES.production;
  const expectedOrigin = `chrome-extension://${identity.extensionId}/`;
  if (process.argv[3] !== expectedOrigin) process.exit(1);
  const dir = fs.lstatSync(config.directory);
  if (!dir.isDirectory() || dir.isSymbolicLink() || (dir.mode & 0o077) || (process.getuid && dir.uid !== process.getuid())) process.exit(1);
  let socket;
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      const bridge = privateFile(path.join(config.directory, 'bridge.json'));
      socket = await new Promise((resolve, reject) => {
        const candidate = net.connect(bridge.socket);
        candidate.once('error', reject);
        candidate.once('connect', () => { candidate.removeListener('error', reject); candidate.write(frame({ auth: bridge.token, origin: expectedOrigin })); resolve(candidate); });
      });
      break;
    } catch {
      if (attempt === 0) {
        // The harness owns model authentication; do not inherit its API/session keys.
        const env = Object.fromEntries(['PATH', 'HOME', 'TMPDIR', 'CODEX_HOME', 'XDG_CONFIG_HOME', 'DISPLAY', 'WAYLAND_DISPLAY', 'DBUS_SESSION_BUS_ADDRESS', 'XDG_RUNTIME_DIR']
          .filter(key => process.env[key]).map(key => [key, process.env[key]]));
        if (config.localOnly && typeof config.localOrigin === 'string') env.BROWSER_APPLICATION_LOCAL_ORIGIN = config.localOrigin;
        const args = [...(config.packaged ? [] : [config.appPath]), '--bridge', ...(config.localOnly ? ['--local-product'] : [])];
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
