import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, realpath, rm, watch, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BROWSER_IDENTITIES } from '../src/browser-identity.mjs';
import { privateDirectory } from '../src/vault.mjs';
import { endpoint, createAuthenticationChallenge, verifyAuthenticationProof } from '../src/platform-runtime.cjs';
import net from 'node:net';

const host = fileURLToPath(new URL('../src/native-host.cjs', import.meta.url));

for (const localOnly of [false, true]) for (const browser of ['chrome', 'firefox']) test(`${browser} launch isolates credentials for the ${localOnly ? 'local' : 'production'} identity`, async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'recruiters-native-env-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await privateDirectory(directory);
  const executable = path.join(directory, 'synthetic-companion.cjs');
  const proof = path.join(directory, 'proof.json');
  await writeFile(executable, `
    const fs = require('node:fs');
    const path = require('node:path');
    const directory = path.dirname(process.argv[1]);
    const has = name => Object.hasOwn(process.env, name);
    fs.writeFileSync(path.join(directory, 'proof.tmp'), JSON.stringify({
      openai: has('OPENAI_API_KEY'), anthropic: has('ANTHROPIC_API_KEY'),
      claudeSession: has('CLAUDE_CODE_OAUTH_TOKEN'),
      electronMode: has('ELECTRON_RUN_AS_NODE'), homePresent: Boolean(process.env.HOME || process.env.USERPROFILE),
    }));
    fs.renameSync(path.join(directory, 'proof.tmp'), path.join(directory, 'proof.json'));
  `, { mode: 0o600 });
  const config = path.join(directory, 'native-config.json');
  const firefoxManifest = path.join(directory, 'firefox manifest.json');
  await writeFile(config, JSON.stringify({ executable: process.execPath, appPath: executable, directory, packaged: false, localOnly, firefoxManifest }), { mode: 0o600 });
  // Watch before launching; the fake app publishes the proof with an atomic rename.
  const events = watch(directory, { signal: AbortSignal.timeout(15000) });
  const observed = (async () => {
    for await (const event of events) {
      if (event.filename === 'proof.json') return JSON.parse(await readFile(proof, 'utf8'));
    }
    throw new Error('Synthetic companion did not publish its environment proof');
  })();
  const identity = localOnly ? BROWSER_IDENTITIES.local : BROWSER_IDENTITIES.production;
  const args = browser === 'chrome' ? [`chrome-extension://${identity.extensionId}/`] : [firefoxManifest, identity.firefoxExtensionId];
  const child = spawn(process.execPath, [host, config, ...args], {
    env: { ...process.env, OPENAI_API_KEY: 'synthetic-openai-secret', ANTHROPIC_API_KEY: 'synthetic-anthropic-secret', CLAUDE_CODE_OAUTH_TOKEN: 'synthetic-claude-session', ELECTRON_RUN_AS_NODE: '1' },
    stdio: ['pipe', 'ignore', 'ignore'],
  });
  t.after(() => { child.kill(); });
  child.once('error', () => { void events.return(); });
  assert.deepEqual(await observed, { openai: false, anthropic: false, claudeSession: false, electronMode: false, homePresent: true });
});

for (const localOnly of [false, true]) test(`native bridge rejects the other product identity in ${localOnly ? 'local' : 'production'} mode`, async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'recruiters-native-origin-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await privateDirectory(directory);
  const config = path.join(directory, 'native-config.json');
  await writeFile(config, JSON.stringify({ executable: process.execPath, appPath: directory, directory, packaged: false, localOnly }), { mode: 0o600 });
  const wrongIdentity = localOnly ? BROWSER_IDENTITIES.production : BROWSER_IDENTITIES.local;
  const child = spawn(process.execPath, [host, config, `chrome-extension://${wrongIdentity.extensionId}/`], { stdio: 'ignore' });
  t.after(() => child.kill());
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
  assert.equal(code, 1);
});

for (const browser of ['chrome', 'firefox']) test(`${browser} native bridge forwards its actual authenticated identity and framed response`, { timeout: 30000 }, async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'rr-native-wire-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await privateDirectory(directory);
  const identity = BROWSER_IDENTITIES.production, firefoxManifest = path.join(directory, 'firefox.json');
  const config = path.join(directory, 'native-config.json'), socketPath = endpoint(directory, 'native'), token = 'a'.repeat(64);
  if (process.platform !== 'win32') await privateDirectory(path.dirname(socketPath));
  if (process.platform !== 'win32' && path.dirname(socketPath) !== await realpath(directory)) t.after(() => rm(path.dirname(socketPath), { recursive: true, force: true }));
  await writeFile(config, JSON.stringify({ executable: process.execPath, appPath: directory, directory, packaged: false, localOnly: false, firefoxManifest }), { mode: 0o600 });
  await writeFile(path.join(directory, 'bridge.json'), JSON.stringify({ socket: socketPath, token }), { mode: 0o600 });
  const expectedOrigin = browser === 'chrome' ? `chrome-extension://${identity.extensionId}/` : identity.firefoxExtensionId;
  let peer;
  const listener = net.createServer(connection => {
    peer = connection;
    let input = Buffer.alloc(0), challenge;
    connection.on('data', chunk => {
      input = Buffer.concat([input, chunk]);
      if (input.length < 4 || input.length < 4 + input.readUInt32LE(0)) return;
      const message = JSON.parse(input.subarray(4, 4 + input.readUInt32LE(0)).toString());
      input = input.subarray(4 + input.readUInt32LE(0));
      const send = value => {
        const body = Buffer.from(JSON.stringify(value)), header = Buffer.alloc(4); header.writeUInt32LE(body.length);
        connection.write(Buffer.concat([header, body]));
      };
      if (!challenge) { challenge = createAuthenticationChallenge(token, 'native', message); send(challenge.message); return; }
      assert.equal(message.origin, expectedOrigin);
      assert.equal(verifyAuthenticationProof(token, 'client', 'native', challenge, message.authProof), true);
      assert.equal(Object.hasOwn(message, 'auth'), false);
      send({ version: 1, ok: true, browser });
    });
  });
  await new Promise((resolve, reject) => { listener.once('error', reject); listener.listen(socketPath, resolve); });
  t.after(() => { peer?.destroy(); listener.close(); });
  const args = browser === 'chrome' ? [expectedOrigin] : [firefoxManifest, expectedOrigin];
  const child = spawn(process.execPath, [host, config, ...args], { stdio: ['pipe', 'pipe', 'ignore'] });
  t.after(() => child.kill());
  const response = await new Promise((resolve, reject) => {
    let output = Buffer.alloc(0);
    child.once('error', reject);
    child.once('exit', code => reject(new Error(`Native host exited before replying: ${code}`)));
    child.stdout.on('data', chunk => {
      output = Buffer.concat([output, chunk]);
      if (output.length >= 4 && output.length >= 4 + output.readUInt32LE(0)) resolve(JSON.parse(output.subarray(4).toString()));
    });
  });
  assert.deepEqual(response, { version: 1, ok: true, browser });
});
