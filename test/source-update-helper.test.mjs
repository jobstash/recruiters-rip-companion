import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import installer from '../src/update-install.cjs';
import { performSourceTransition } from '../src/source-update-helper.mjs';
import { prepareSourceRoot, discoverSourceTools, runSourceCommand, sourceEnvironment, sourceExecutable, writeSourceJSON, readSourceJSON } from '../scripts/install-source.mjs';

const nativeWait = process.platform === 'win32' ? 60000 : 20000;
const options = { skip: !process.versions.node.startsWith('24.'), timeout: 180000 };
const installerFile = fileURLToPath(new URL('../src/update-install.cjs', import.meta.url));

function bounded(promise, timeout = nativeWait, label = 'fixture event') {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), timeout); })]).finally(() => clearTimeout(timer));
}

async function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode) return;
  const exited = new Promise(resolve => child.once('exit', resolve));
  if (child.connected) child.send({ type: 'release' }, () => {});
  else child.kill('SIGTERM');
  try { await bounded(exited, 5000, 'owned fixture shutdown'); }
  catch { child.kill('SIGKILL'); await bounded(exited, 5000, 'owned fixture termination'); }
}

async function waitForFixtureExit(pid) {
  const deadline = Date.now() + 5000;
  for (;;) {
    try { process.kill(pid, 0); } catch (error) { if (error.code === 'ESRCH') return; throw error; }
    if (Date.now() >= deadline) throw new Error(`Owned source fixture ${pid} did not exit after its gate closed.`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

async function childGate() {
  const token = randomBytes(24).toString('hex');
  const events = [], sockets = new Set(), waiters = new Set();
  let closing = false;
  const server = net.createServer(socket => {
    sockets.add(socket);
    let buffer = '';
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
    socket.on('data', chunk => {
      buffer += chunk.toString('utf8');
      if (buffer.length > 16384) { socket.destroy(); return; }
      for (;;) {
        const end = buffer.indexOf('\n');
        if (end < 0) break;
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        let message;
        try { message = JSON.parse(line); } catch { socket.destroy(); return; }
        if (message.token !== token || !['previous', 'next'].includes(message.role) || !Number.isSafeInteger(message.pid)) { socket.destroy(); return; }
        const event = { ...message, socket };
        events.push(event);
        if (closing && event.type === 'started') socket.write('{"command":"exit"}\n');
        for (const waiter of [...waiters]) if (waiter.role === event.role && waiter.type === event.type) { waiters.delete(waiter); waiter.resolve(event); }
      }
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return {
    token, port: server.address().port, events,
    requestStop() { closing = true; for (const socket of sockets) if (!socket.destroyed) socket.write('{"command":"exit"}\n'); },
    async close() {
      for (const socket of sockets) socket.destroy();
      await bounded(new Promise(resolve => server.close(resolve)), 5000, 'fixture listener shutdown');
      await Promise.all([...new Set(events.map(event => event.pid))].map(waitForFixtureExit));
    },
    async wait(role, type = 'started') {
      const found = events.find(event => event.role === role && event.type === type);
      if (found) return found;
      let waiter;
      try { return await bounded(new Promise(resolve => { waiter = { role, type, resolve }; waiters.add(waiter); }), nativeWait, `${role} ${type}`); }
      finally { waiters.delete(waiter); }
    },
    send(event, command) { event.socket.write(`${JSON.stringify({ command })}\n`); },
  };
}

function fixtureMain({ root, role, gate }) {
  // These children really execute and exit, but never write confirmed.json or
  // pretend to be a ready Companion. Only their loopback test gate is contacted.
  return `import net from 'node:net';
const config = ${JSON.stringify({ root, role, token: gate.token, port: gate.port, installer: pathToFileURL(installerFile).href })};
const socket = net.connect({ host: '127.0.0.1', port: config.port });
const send = (type, extra = {}) => socket.write(JSON.stringify({ token: config.token, role: config.role, type, pid: process.pid, args: process.argv.slice(2), ...extra }) + '\\n');
const finish = code => socket.end(() => process.exit(code));
socket.on('connect', () => send('started'));
socket.on('error', () => process.exit(91));
socket.on('close', () => process.exit(0));
let buffer = '';
socket.on('data', async chunk => {
  buffer += chunk.toString('utf8');
  for (;;) {
    const end = buffer.indexOf('\\n'); if (end < 0) return;
    const request = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
    if (request.command === 'exit') { send('exiting'); finish(config.role === 'next' ? 17 : 0); return; }
    if (request.command === 'check-competing-lease') {
      const { default: installer } = await import(config.installer);
      const release = await installer.claimInstallation(config.root);
      if (release) { await release(); send('unexpected-lease'); finish(92); }
      else { send('duplicate-refused'); finish(0); }
      return;
    }
  }
});
`;
}

async function fakeElectron(sourceRoot) {
  const executable = sourceExecutable(sourceRoot);
  await fs.mkdir(path.dirname(executable), { recursive: true, mode: 0o700 });
  if (process.platform === 'win32') {
    // Windows cannot execute a shell file named .exe. Reuse the real Node PE as
    // the synthetic runtime; it still launches the committed fixture main file.
    try { await fs.link(process.execPath, executable); }
    catch (error) { if (!['EXDEV', 'EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) throw error; await fs.copyFile(process.execPath, executable); }
  } else {
    const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
    await fs.writeFile(executable, `#!/bin/sh\nexec ${quote(process.execPath)} "$@"\n`, { mode: 0o700 });
  }
  const electron = path.join(sourceRoot, 'node_modules', 'electron');
  await fs.writeFile(path.join(electron, 'package.json'), JSON.stringify({ name: 'electron', version: '45.1.0' }));
  await fs.writeFile(path.join(electron, 'dist', 'version'), '45.1.0');
}

async function createVersion({ root, version, role, tools, gate }) {
  const sourceRoot = path.join(root, 'versions', `fixture-${version}`, 'source');
  await fs.mkdir(path.join(sourceRoot, 'src', 'generated'), { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(sourceRoot, 'package.json'), JSON.stringify({
    name: 'recruiters-companion', version, type: 'module', main: 'src/main.mjs',
    packageManager: 'pnpm@10.28.0', build: { appId: 'rip.recruiters.companion' }, devDependencies: { electron: '45.1.0' },
  }));
  await fs.writeFile(path.join(sourceRoot, '.gitignore'), 'node_modules/\nsrc/generated/\nbrowser-extension/dist/\n');
  const lock = 'lockfileVersion: "9.0"\n';
  await fs.writeFile(path.join(sourceRoot, 'pnpm-lock.yaml'), lock);
  await fs.writeFile(path.join(sourceRoot, 'src', 'main.mjs'), fixtureMain({ root, role, gate }));
  for (const name of ['document-engine.cjs', 'mcp-host.cjs', 'skill-digest.mjs']) await fs.writeFile(path.join(sourceRoot, 'src', 'generated', name), '// synthetic validation fixture\n');
  for (const browser of ['production', 'firefox-production']) {
    const folder = path.join(sourceRoot, 'browser-extension', 'dist', browser);
    await fs.mkdir(folder, { recursive: true, mode: 0o700 });
    await fs.writeFile(path.join(folder, 'manifest.json'), JSON.stringify({ version }));
  }
  await fakeElectron(sourceRoot);
  await runSourceCommand(tools.git, ['init', sourceRoot]);
  await runSourceCommand(tools.git, ['-C', sourceRoot, 'add', '.']);
  await runSourceCommand(tools.git, ['-C', sourceRoot, '-c', 'user.name=Source Recovery Test', '-c', 'user.email=source-recovery@example.invalid', 'commit', '-m', 'synthetic source recovery fixture']);
  const commit = (await runSourceCommand(tools.git, ['-C', sourceRoot, 'rev-parse', 'HEAD'])).trim();
  await writeSourceJSON(path.join(path.dirname(sourceRoot), 'receipt.json'), {
    schema: 1, root, sourceRoot, version, commit, provenance: 'local-candidate', tag: `v${version}`,
    lockDigest: createHash('sha256').update(lock).digest('hex'), tools,
  });
  return { schema: 1, sourceRoot, version };
}

async function exitedPid() {
  const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { env: sourceEnvironment(), stdio: 'ignore' });
  await bounded(new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(new Error('Old fixture did not exit cleanly.'))); }), 5000, 'old fixture exit');
  return child.pid;
}

async function fixture(t) {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'recruiters-source-recovery-')));
  const lifetime = { children: [], gate: null, transition: null };
  t.after(async () => {
    for (const child of lifetime.children) await stopChild(child);
    lifetime.gate?.requestStop();
    if (lifetime.transition) await bounded(lifetime.transition.catch(() => {}), nativeWait, 'source transition cleanup');
    await lifetime.gate?.close();
    await fs.rm(directory, { recursive: true, force: true });
  });
  const root = await prepareSourceRoot(path.join(directory, 'managed'));
  const gate = lifetime.gate = await childGate(), tools = await discoverSourceTools();
  const previous = await createVersion({ root, version: '3.11.0', role: 'previous', tools, gate });
  const next = await createVersion({ root, version: '3.12.0', role: 'next', tools, gate });
  const userData = path.join(directory, "isolated profile 'selected'");
  await fs.mkdir(path.join(userData, 'device'), { recursive: true, mode: 0o700 });
  const sentinel = path.join(userData, 'device', 'synthetic-data.json'), data = '{"synthetic":"preserve exactly"}\n';
  await fs.writeFile(sentinel, data);
  Object.assign(previous, { userData }); Object.assign(next, { userData });
  await writeSourceJSON(path.join(root, 'current.json'), previous);
  const id = randomBytes(16).toString('hex'), work = path.join(root, 'transitions', id);
  await fs.mkdir(work, { mode: 0o700 });
  const journal = { schema: 1, id, root, journal: path.join(work, 'journal.json'), pid: await exitedPid(), version: next.version, previous, next, userData, status: 'prepared' };
  await writeSourceJSON(journal.journal, journal);
  return { root, gate, previous, next, journal, sentinel, data, lifetime };
}

async function competingLease(f) {
  const code = `const installer=require(process.argv[1]);let release;
const finish=async()=>{const held=release;release=null;await held?.();process.exit(0)};
process.on('message',message=>{if(message?.type==='release')void finish()});process.on('disconnect',()=>void finish());
installer.claimInstallation(process.argv[2]).then(held=>{release=held;process.send({type:'lease',held:!!held});if(!held)process.exit(2)}).catch(error=>{process.send({type:'error',message:error.message});process.exit(3)});`;
  const child = spawn(process.execPath, ['-e', code, installerFile, f.root], { env: sourceEnvironment(), stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  f.lifetime.children.push(child);
  const ready = await bounded(new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', code => reject(new Error(`Competing fixture exited before acquiring its lease (${code}).`)));
    child.once('message', resolve);
  }), nativeWait, 'competing installation lease');
  assert.deepEqual(ready, { type: 'lease', held: true });
  return child;
}

async function assertRetained(f) {
  assert.equal(await fs.readFile(f.sentinel, 'utf8'), f.data);
  assert.equal((await fs.stat(f.previous.sourceRoot)).isDirectory(), true);
  assert.equal((await fs.stat(f.next.sourceRoot)).isDirectory(), true);
  await assert.rejects(fs.lstat(path.join(path.dirname(f.journal.journal), 'confirmed.json')), { code: 'ENOENT' });
}

test('source startup failure restores the pointer and actually launches the previous child with the exact profile', options, async t => {
  const f = await fixture(t);
  const transition = f.lifetime.transition = performSourceTransition(f.journal, { confirmationTimeout: 15000 });
  // Attach rejection handling while the real child communicates with the gate.
  transition.catch(() => {});
  const candidate = await f.gate.wait('next');
  assert.deepEqual(candidate.args, [`--user-data-dir=${f.journal.userData}`]);
  f.gate.send(candidate, 'exit');
  await bounded(transition, nativeWait, 'source rollback');
  const previous = await f.gate.wait('previous');
  assert.deepEqual(previous.args, [`--user-data-dir=${f.journal.userData}`]);
  assert.notEqual(previous.pid, candidate.pid);
  assert.deepEqual(await readSourceJSON(path.join(f.root, 'current.json')), f.previous);
  assert.equal((await readSourceJSON(f.journal.journal)).status, 'rolled-back');
  await assertRetained(f);
  f.gate.send(previous, 'exit');
  await f.gate.wait('previous', 'exiting');
});

test('a competing installation lease before source transition leaves the existing pointer and both trees untouched', options, async t => {
  const f = await fixture(t), owner = await competingLease(f);
  const before = await fs.readFile(path.join(f.root, 'current.json'), 'utf8');
  f.lifetime.transition = performSourceTransition(f.journal, { confirmationTimeout: 1000 });
  await bounded(f.lifetime.transition, nativeWait, 'blocked source handoff');
  assert.equal(await fs.readFile(path.join(f.root, 'current.json'), 'utf8'), before);
  assert.equal((await readSourceJSON(f.journal.journal)).status, 'unconfirmed');
  assert.equal(f.gate.events.length, 0);
  assert.doesNotThrow(() => process.kill(owner.pid, 0));
  const extraLease = await installer.claimInstallation(f.root);
  await extraLease?.();
  assert.equal(extraLease, null);
  await assertRetained(f);
});

test('a competing owner after pointer switch causes duplicate child exit without rollback over that owner', options, async t => {
  const f = await fixture(t);
  const transition = f.lifetime.transition = performSourceTransition(f.journal, { confirmationTimeout: 15000 });
  transition.catch(() => {});
  const candidate = await f.gate.wait('next');
  assert.deepEqual(await readSourceJSON(path.join(f.root, 'current.json')), f.next);
  const owner = await competingLease(f);
  f.gate.send(candidate, 'check-competing-lease');
  const duplicate = await f.gate.wait('next', 'duplicate-refused');
  assert.equal(duplicate.pid, candidate.pid);
  assert.deepEqual(duplicate.args, [`--user-data-dir=${f.journal.userData}`]);
  await bounded(transition, nativeWait, 'unconfirmed source retention');
  assert.equal((await readSourceJSON(f.journal.journal)).status, 'unconfirmed');
  assert.deepEqual(await readSourceJSON(path.join(f.root, 'current.json')), f.next);
  assert.equal(f.gate.events.some(event => event.role === 'previous'), false);
  assert.doesNotThrow(() => process.kill(owner.pid, 0));
  const extraLease = await installer.claimInstallation(f.root);
  await extraLease?.();
  assert.equal(extraLease, null);
  await assertRetained(f);
});
