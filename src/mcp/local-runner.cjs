#!/usr/bin/env node
'use strict';
const path = require('node:path');
const { realpathSync } = require('node:fs');
const { spawn } = require('node:child_process');
const { endpoint, restrictedEnvironment, assertPrivatePath, privateJSON, connectAuthenticated } = require('../platform-runtime.cjs');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function main() {
  let local = false, selected;
  for (const arg of process.argv.slice(2)) {
    if (arg === '--local-product' && !local) local = true;
    else if (arg.startsWith('--directory=') && selected === undefined) selected = arg.slice('--directory='.length);
    else throw new Error('Unsupported connection option.');
  }
  if (typeof selected !== 'string' || !path.isAbsolute(selected)) throw new Error('Choose the configured companion profile.');
  assertPrivatePath(selected, { directory: true });
  const directory = realpathSync(selected), userData = realpathSync(path.dirname(directory));
  if (directory !== path.join(userData, local ? 'local-device' : 'device')) throw new Error('Invalid companion profile.');
  const launch = privateJSON(path.join(directory, 'mcp-launch.json'));
  if (!path.isAbsolute(launch.executable) || !Array.isArray(launch.args) || launch.args.some(arg => typeof arg !== 'string') ||
      launch.localOnly !== local || launch.directory !== directory || launch.userData !== userData) throw new Error('Invalid companion installation.');
  const profileArgs = launch.args.filter(arg => arg.startsWith('--user-data-dir'));
  if (profileArgs.length !== 1 || profileArgs[0] !== `--user-data-dir=${userData}`) throw new Error('Invalid companion launch profile.');
  let socket;
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      const config = privateJSON(path.join(directory, 'mcp-bridge.json'));
      if (config.socket !== endpoint(directory, 'mcp') || !/^[a-f0-9]{64}$/.test(config.token)) throw new Error('Invalid local connection.');
      if (process.platform !== 'win32') assertPrivatePath(path.dirname(config.socket), { directory: true });
      socket = await connectAuthenticated(config.socket, config.token, 'mcp');
      break;
    } catch {
      if (attempt === 0) {
        // Do not pass model tokens, API keys, proxies, or shell startup options to the companion.
        const env = restrictedEnvironment();
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
