#!/usr/bin/env node
// Builds the container image from this source and proves the three ways into it work:
// the browser screens (behind the access code), the AI-app tools over `docker exec`, and the browser-extension setup script.
// Uses a throwaway container, volume and synthetic data only. Usage: node scripts/smoke-container.mjs [--no-build]
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const run = promisify(execFile);
const root = fileURLToPath(new URL('..', import.meta.url));
const image = 'recruiters-companion:smoke', name = `recruiters-companion-smoke-${process.pid}`, volume = `${name}-data`, port = 43000 + process.pid % 1000;
const origin = `http://127.0.0.1:${port}`;
const docker = (...args) => run('docker', args, { cwd: root, maxBuffer: 64 * 1024 * 1024 }).then(result => result.stdout.trim());

async function start() {
  await docker('run', '--detach', '--name', name, '--init', '--read-only', '--tmpfs', '/tmp', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true',
    '--env', `RECRUITERS_COMPANION_CONTAINER=${name}`, '--env', `RECRUITERS_COMPANION_WEB_PORT=${port}`, '--publish', `127.0.0.1:${port}:${port}`, '--volume', `${volume}:/data`, image);
  for (let attempt = 0; attempt < 60; attempt++) {
    try { if ((await fetch(`${origin}/design-tokens.css`)).ok && (await docker('exec', name, 'companion', 'url')).startsWith(origin)) return; } catch { /* Still starting. */ }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error(`The container did not start:\n${await docker('logs', name).catch(error => error.message)}`);
}

// One AI-app session: newline-delimited JSON-RPC over the same command the setup prompt gives to Codex and Claude.
async function tools() {
  const child = spawn('docker', ['exec', '-i', name, '/data/device/recruiters-rip-mcp'], { stdio: ['pipe', 'pipe', 'inherit'] });
  const replies = new Map(); let buffer = '', notify = () => {};
  child.stdout.on('data', chunk => {
    buffer += chunk;
    for (let end = buffer.indexOf('\n'); end >= 0; end = buffer.indexOf('\n')) {
      const message = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
      if (message.id) { replies.set(message.id, message); notify(); }
    }
  });
  const send = message => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
  const call = async (id, method, params) => {
    send({ id, method, params });
    const deadline = Date.now() + 20000;
    while (!replies.has(id)) {
      if (Date.now() > deadline) throw new Error(`No reply to ${method} over docker exec.`);
      await new Promise(resolve => { notify = resolve; setTimeout(resolve, 250); });
    }
    return replies.get(id).result;
  };
  try {
    const hello = await call(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'smoke', version: '1' } });
    send({ method: 'notifications/initialized' });
    const listed = await call(2, 'tools/list', {});
    const profile = await call(3, 'tools/call', { name: 'career_profile_read', arguments: {} });
    return { hello, names: listed.tools.map(tool => tool.name), profile: JSON.parse(profile.content[0].text) };
  } finally { child.stdin.end(); child.kill(); }
}

try {
  if (!process.argv.includes('--no-build')) await docker('build', '--pull', '--tag', image, '.');
  await start();
  assert.equal(await docker('exec', name, 'id', '-un'), 'node', 'Companion must not run as root');

  // Browser screens: nothing without the access code, the settings bridge with it.
  assert.equal((await fetch(`${origin}/api/invoke`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: '{"op":"state"}' })).status, 401);
  const token = new URL(await docker('exec', name, 'companion', 'url')).hash.slice('#access='.length);
  const session = await fetch(`${origin}/api/session`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) });
  const cookie = session.headers.get('set-cookie').split(';')[0];
  const invoke = async () => (await fetch(`${origin}/api/invoke`, { method: 'POST', headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json' }, body: '{"op":"state"}' })).json();
  const state = (await invoke()).result;
  assert.deepEqual(state.shell, { web: true, container: name, browserSetup: { chrome: `docker exec ${name} companion browser chrome | sh`, firefox: `docker exec ${name} companion browser firefox | sh` } });
  assert.equal(state.execution.state, 'needs_connection', 'A new profile opens unlocked and waits for an account');
  assert.ok(state.setup.agentPrompt.includes(`docker exec -i ${name} /data/device/recruiters-rip-mcp`));

  // AI apps: the tools answer over docker exec, and say where Companion's window is.
  const session1 = await tools();
  assert.equal(session1.hello.serverInfo.name, 'recruiters-rip');
  assert.ok(session1.hello.instructions.includes(`docker exec ${name} companion url`));
  assert.ok(session1.names.includes('career_application_export') && session1.names.length > 40);
  assert.equal(session1.profile.revision, 0);

  // Browser extension: the host script is valid shell and carries this container's launcher.
  for (const browser of ['chrome', 'firefox']) {
    const script = await docker('exec', name, 'companion', 'browser', browser);
    assert.ok(script.includes(`'/data/device/recruiters-native-host'`) && script.includes(`container='${name}'`));
    await new Promise((resolve, reject) => {
      const shell = spawn('/bin/sh', ['-n'], { stdio: ['pipe', 'inherit', 'inherit'] });
      shell.once('exit', code => code === 0 ? resolve() : reject(new Error(`The ${browser} setup script is not valid shell.`)));
      shell.stdin.end(script);
    });
  }

  // A rebuilt or restarted container keeps the profile and the browser's sign-in.
  await docker('rm', '--force', name);
  await start();
  const restarted = (await invoke()).result;
  assert.equal(restarted.deviceId, state.deviceId);
  console.log(`Container smoke passed: ${session1.names.length} tools over docker exec, profile ${state.deviceId} kept across a restart.`);
} finally {
  await docker('rm', '--force', name).catch(() => {});
  await docker('volume', 'rm', '--force', volume).catch(() => {});
}
