#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const { spawn } = require('node:child_process');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
function privateJSON(file) {
  const info = fs.lstatSync(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 16384 || (process.getuid && info.uid !== process.getuid()) || (info.mode & 0o077)) throw new Error('Invalid local connection configuration.');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
async function main() {
  if (process.argv.slice(2).some(arg => arg !== '--local-product')) throw new Error('Unsupported connection option.');
  if (!['darwin', 'linux'].includes(process.platform)) throw new Error('This local companion package supports macOS and Linux.');
  const local = process.argv.includes('--local-product');
  const support = process.platform === 'darwin' ? path.join(os.homedir(), 'Library', 'Application Support') : process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  const directory = path.join(support, 'Recruiters Companion', local ? 'local-device' : 'device');
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) || (process.getuid && stat.uid !== process.getuid())) throw new Error('Local companion storage is unavailable.');
  const launch = privateJSON(path.join(directory, 'mcp-launch.json'));
  if (!path.isAbsolute(launch.executable) || !Array.isArray(launch.args) || launch.args.some(arg => typeof arg !== 'string') || launch.localOnly !== local) throw new Error('Invalid companion installation.');
  let socket;
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      const config = privateJSON(path.join(directory, 'mcp-bridge.json'));
      if (config.socket !== path.join(directory, 'mcp.sock') || !/^[a-f0-9]{64}$/.test(config.token)) throw new Error('Invalid local connection.');
      socket = await new Promise((resolve, reject) => {
        const connection = net.connect(config.socket);
        connection.once('error', error => { connection.destroy(); reject(error); });
        connection.once('connect', () => { connection.removeAllListeners('error'); connection.write(JSON.stringify({ auth: config.token }) + '\n'); resolve(connection); });
      });
      break;
    } catch {
      if (attempt === 0) {
        // Do not pass model tokens, API keys, proxies, or shell startup options to the companion.
        const env = Object.fromEntries(['PATH', 'HOME', 'TMPDIR', 'XDG_CONFIG_HOME', 'DISPLAY', 'WAYLAND_DISPLAY', 'DBUS_SESSION_BUS_ADDRESS', 'XDG_RUNTIME_DIR'].filter(key => process.env[key]).map(key => [key, process.env[key]]));
        const child = spawn(launch.executable, [...launch.args, '--mcp-background'], { env, detached: true, stdio: 'ignore' });
        child.on('error', () => {}); child.unref();
      }
      await wait(250);
    }
  }
  if (!socket) throw new Error('Open Recruiters.rip Companion, unlock local storage, and reconnect this MCP server.');
  socket.on('error', () => { process.stderr.write('Recruiters.rip local MCP connection closed. Reopen the companion.\n'); process.exitCode = 1; process.stdin.destroy(); });
  socket.on('close', () => { process.stdin.destroy(); });
  process.stdin.pipe(socket); socket.pipe(process.stdout);
  process.stdin.on('end', () => socket.end());
  process.on('SIGTERM', () => { socket.destroy(); process.exit(0); });
  process.on('SIGINT', () => { socket.destroy(); process.exit(0); });
}
main().catch(() => { process.stderr.write('Recruiters.rip local MCP could not start. Install and open Recruiters.rip Companion, then reconnect.\n'); process.exitCode = 1; });
