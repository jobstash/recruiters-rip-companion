import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { endpoint, deviceDirectory, protectPrivatePath, connectAuthenticated, createAuthenticationChallenge, verifyAuthenticationProof } from '../src/platform-runtime.cjs';
import { privateDirectory } from '../src/vault.mjs';
import { startMcpBroker } from '../src/mcp/broker.mjs';
import { BROWSER_IDENTITIES } from '../src/browser-identity.mjs';

const token = 'a'.repeat(64);
function frame(channel, value) {
  const body = Buffer.from(JSON.stringify(value));
  if (channel === 'mcp') return Buffer.concat([body, Buffer.from('\n')]);
  const header = Buffer.alloc(4); header.writeUInt32LE(body.length);
  return Buffer.concat([header, body]);
}
function message(channel, bytes) {
  if (channel === 'mcp') { const end = bytes.indexOf(10); return end < 0 ? null : JSON.parse(bytes.subarray(0, end).toString()); }
  if (bytes.length < 4 || bytes.length < 4 + bytes.readUInt32LE(0)) return null;
  return JSON.parse(bytes.subarray(4, 4 + bytes.readUInt32LE(0)).toString());
}
async function privateEndpoint(directory, channel, t) {
  const socket = endpoint(directory, channel);
  if (process.platform !== 'win32') {
    await privateDirectory(path.dirname(socket));
    if (path.dirname(socket) !== await realpath(directory)) t.after(() => rm(path.dirname(socket), { recursive: true, force: true }));
  }
  return socket;
}

test('proofs bind role, transport channel and both fresh nonces', () => {
  const hello = { hello: 'b'.repeat(64) };
  const first = createAuthenticationChallenge(token, 'native', hello);
  const second = createAuthenticationChallenge(token, 'native', hello);
  assert.notEqual(first.serverNonce, second.serverNonce);
  assert.equal(verifyAuthenticationProof(token, 'server', 'native', first, first.message.proof), true);
  assert.equal(verifyAuthenticationProof(token, 'client', 'native', first, first.message.proof), false);
  assert.equal(verifyAuthenticationProof(token, 'server', 'mcp', first, first.message.proof), false);
  assert.equal(verifyAuthenticationProof(token, 'server', 'native', second, first.message.proof), false);
  const clientProof = createHmac('sha256', Buffer.from(token, 'hex')).update(`recruiters-companion-v1\0client\0native\0${first.clientNonce}\0${first.serverNonce}`).digest('hex');
  assert.equal(verifyAuthenticationProof(token, 'client', 'native', first, clientProof), true);
  assert.equal(verifyAuthenticationProof(token, 'client', 'native', second, clientProof), false);
  assert.throws(() => createAuthenticationChallenge(token, 'native', { ...hello, auth: token }));
});

for (const channel of ['native', 'mcp']) test(`${channel} client withholds its private token and queued application data from a squatted endpoint`, { timeout: 30000 }, async t => {
  const home = await mkdtemp(path.join(tmpdir(), 'rr-impersonation-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const env = { ...process.env, HOME: home, USERPROFILE: home, APPDATA: path.join(home, 'Roaming'), XDG_CONFIG_HOME: path.join(home, 'config') };
  const directory = deviceDirectory({ env, home });
  await privateDirectory(directory);
  const selected = await realpath(directory), userData = path.dirname(selected);
  const socketPath = await privateEndpoint(directory, channel, t);
  const stub = path.join(home, 'synthetic-app.cjs'); await writeFile(stub, '');
  if (channel === 'mcp') await writeFile(path.join(directory, 'mcp-launch.json'), JSON.stringify({ executable: process.execPath,
    args: [stub, `--user-data-dir=${userData}`], directory: selected, userData, localOnly: false }), { mode: 0o600 });
  else await writeFile(path.join(directory, 'native-config.json'), JSON.stringify({ executable: process.execPath, appPath: stub, directory: selected, userData, packaged: false, localOnly: false }), { mode: 0o600 });
  await writeFile(path.join(directory, channel === 'mcp' ? 'mcp-bridge.json' : 'bridge.json'), JSON.stringify({ socket: socketPath, token }), { mode: 0o600 });
  // Match production's explicit file DACLs, not only POSIX mode bits.
  protectPrivatePath(path.join(directory, channel === 'mcp' ? 'mcp-launch.json' : 'native-config.json'));
  protectPrivatePath(path.join(directory, channel === 'mcp' ? 'mcp-bridge.json' : 'bridge.json'));
  const captured = [];
  let disconnected;
  const rejected = new Promise(resolve => { disconnected = resolve; });
  const peers = new Set();
  const fake = net.createServer(socket => {
    peers.add(socket);
    let input = Buffer.alloc(0), replied = false;
    socket.on('error', () => {});
    socket.on('data', bytes => {
      captured.push(bytes); input = Buffer.concat([input, bytes]);
      if (!replied && message(channel, input)) { replied = true; socket.write(frame(channel, { challenge: 'c'.repeat(64), proof: '0'.repeat(64) })); }
    });
    socket.on('close', () => { peers.delete(socket); disconnected(); });
  });
  await new Promise((resolve, reject) => { fake.once('error', reject); fake.listen(socketPath, resolve); });
  t.after(() => { for (const peer of peers) peer.destroy(); fake.close(); });
  const script = fileURLToPath(new URL(channel === 'mcp' ? '../src/mcp/local-runner.cjs' : '../src/native-host.cjs', import.meta.url));
  const args = channel === 'mcp' ? [`--directory=${selected}`] : [path.join(directory, 'native-config.json'), `chrome-extension://${BROWSER_IDENTITIES.production.extensionId}/`];
  const child = spawn(process.execPath, [script, ...args], { env, stdio: ['pipe', 'ignore', 'ignore'] });
  const exited = new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); });
  t.after(() => child.kill());
  child.stdin.on('error', () => {});
  child.stdin.write(frame(channel, { privateApplication: 'private-career-sentinel' }));
  await Promise.race([rejected, exited.then(code => { throw new Error(`Client exited (${code}) before rejecting the impersonating endpoint.`); })]);
  child.kill(); await exited;
  const bytes = Buffer.concat(captured), first = message(channel, bytes);
  assert.deepEqual(Object.keys(first), ['hello']);
  assert.match(first.hello, /^[a-f0-9]{64}$/);
  assert.equal(bytes.includes(Buffer.from(token)), false);
  assert.equal(bytes.includes(Buffer.from('private-career-sentinel')), false);
  assert.equal(bytes.includes(Buffer.from('authProof')), false);
});

test('overlong Unix storage paths use private bounded sockets and canonical aliases agree', { skip: process.platform === 'win32', timeout: 30000 }, async t => {
  const home = await mkdtemp(path.join(tmpdir(), 'rr-long-path-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const directory = path.join(home, 'long-home-directory-name'.repeat(5), 'device');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const socketPath = await privateEndpoint(directory, 'mcp', t);
  assert.ok(Buffer.byteLength(socketPath) < 104);
  assert.equal(endpoint(await realpath(directory), 'mcp'), socketPath);
  const broker = await startMcpBroker({ directory, createServer: () => ({ async connect(transport) { transport.onmessage = value => transport.send(value); }, async close() {} }) });
  t.after(() => broker.close());
  const config = JSON.parse(await readFile(path.join(directory, 'mcp-bridge.json'), 'utf8'));
  const socket = await connectAuthenticated(config.socket, config.token, 'mcp');
  t.after(() => socket.destroy());
  const reply = new Promise(resolve => socket.once('data', value => resolve(JSON.parse(value.toString()))));
  socket.resume(); socket.write(JSON.stringify({ echo: 'synthetic' }) + '\n');
  assert.deepEqual(await reply, { echo: 'synthetic' });
});
