import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, watch, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BROWSER_IDENTITIES } from '../src/browser-identity.mjs';

const host = fileURLToPath(new URL('../src/native-host.cjs', import.meta.url));

for (const localOnly of [false, true]) test(`browser launch isolates credentials for the ${localOnly ? 'local' : 'production'} identity`, { skip: process.platform === 'win32' }, async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'recruiters-native-env-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
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
      electronMode: has('ELECTRON_RUN_AS_NODE'), homePresent: Boolean(process.env.HOME),
    }));
    fs.renameSync(path.join(directory, 'proof.tmp'), path.join(directory, 'proof.json'));
  `, { mode: 0o600 });
  const config = path.join(directory, 'native-config.json');
  await writeFile(config, JSON.stringify({ executable: process.execPath, appPath: executable, directory, packaged: false, localOnly }), { mode: 0o600 });
  // Watch before launching; the fake app publishes the proof with an atomic rename.
  const events = watch(directory, { signal: AbortSignal.timeout(5000) });
  const observed = (async () => {
    for await (const event of events) {
      if (event.filename === 'proof.json') return JSON.parse(await readFile(proof, 'utf8'));
    }
    throw new Error('Synthetic companion did not publish its environment proof');
  })();
  const identity = localOnly ? BROWSER_IDENTITIES.local : BROWSER_IDENTITIES.production;
  const child = spawn(process.execPath, [host, config, `chrome-extension://${identity.extensionId}/`], {
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
  const config = path.join(directory, 'native-config.json');
  await writeFile(config, JSON.stringify({ executable: process.execPath, appPath: directory, directory, packaged: false, localOnly }), { mode: 0o600 });
  const wrongIdentity = localOnly ? BROWSER_IDENTITIES.production : BROWSER_IDENTITIES.local;
  const child = spawn(process.execPath, [host, config, `chrome-extension://${wrongIdentity.extensionId}/`], { stdio: 'ignore' });
  t.after(() => child.kill());
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
  assert.equal(code, 1);
});
