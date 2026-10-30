import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fail } from '../src/mcp/state.mjs';
import { createUpdatePreferences, createUpdateScheduler, createUpdateWorkGate, updateAppPath, validateUpdatePreferences, UPDATE_INTERVAL, UPDATE_QUIET_WINDOW } from '../src/update-scheduler.mjs';

const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const turn = () => new Promise(resolve => setImmediate(resolve));

function schedulerFixture({ automatic = true, supported = true, releaseStatus = 'current', initialStatus = 'idle', download, check, install } = {}) {
  let time = 1_000, timer, preference = automatic;
  const calls = [], view = { status: initialStatus, automaticSupported: supported }, environment = { idle: false, suspended: false };
  const updates = {
    state: () => ({ ...view }),
    async check() { calls.push('check'); view.status = 'checking'; await check?.(); view.status = releaseStatus; },
    async download() { calls.push('download'); view.status = 'downloading'; await download?.(); view.status = 'downloaded'; },
  };
  const scheduler = createUpdateScheduler({ updates,
    preferences: { load: async () => ({ automaticUpdates: preference }), save: async value => { preference = value.automaticUpdates; } },
    install: async options => { calls.push(['install', options]); if (install) await install(); else view.status = 'installing'; },
    canInstall: () => environment.idle, suspended: () => environment.suspended,
    now: () => time, setTimer: (callback, delay) => { timer = { callback, delay }; return timer; }, clearTimer: () => { timer = undefined; },
  });
  return { scheduler, view, calls, environment, advance: value => { time += value; }, timer: () => timer,
    async fire() { assert.ok(timer); timer.callback(); await scheduler.settled(); } };
}

test('automatic checks run at startup, every six hours and after missed resume intervals', async () => {
  const fixture = schedulerFixture();
  await fixture.scheduler.start();
  assert.deepEqual(fixture.calls, ['check']);
  assert.equal(fixture.scheduler.state().enabled, true);
  assert.equal(fixture.scheduler.state().lastCheckedAt, 1_000);
  assert.equal(fixture.scheduler.state().nextCheckAt, 1_000 + UPDATE_INTERVAL);
  assert.equal(fixture.timer().delay, 60_000);
  fixture.advance(UPDATE_INTERVAL - 1);
  await fixture.fire();
  assert.deepEqual(fixture.calls, ['check']);
  fixture.advance(1);
  await fixture.fire();
  assert.deepEqual(fixture.calls, ['check', 'check']);
  fixture.advance(3 * UPDATE_INTERVAL);
  await fixture.scheduler.resume();
  assert.deepEqual(fixture.calls, ['check', 'check', 'check']);
  fixture.scheduler.stop();
  assert.equal(fixture.timer(), undefined);
});

test('a verified pending download is kept across check deadlines until idle', async () => {
  const fixture = schedulerFixture({ releaseStatus: 'available' });
  await fixture.scheduler.start();
  assert.deepEqual(fixture.calls, ['check', 'download']);
  assert.equal(fixture.scheduler.state().waitingForIdle, true);
  fixture.advance(2 * UPDATE_INTERVAL);
  await fixture.scheduler.resume();
  await fixture.scheduler.checkNow();
  assert.deepEqual(fixture.calls, ['check', 'download']);
  fixture.environment.idle = true;
  await fixture.fire();
  assert.deepEqual(fixture.calls, ['check', 'download', ['install', { automatic: true }]]);
  assert.equal(fixture.scheduler.state().waitingForIdle, false);
  fixture.scheduler.stop();
});

test('disabling during download preserves it without installing or starting future cycles', async () => {
  const waiting = deferred(), began = deferred();
  const fixture = schedulerFixture({ releaseStatus: 'available', download: () => { began.resolve(); return waiting.promise; } });
  fixture.environment.idle = true;
  const startup = fixture.scheduler.start();
  await began.promise;
  await fixture.scheduler.setPreferences({ automaticUpdates: false });
  waiting.resolve(); await startup;
  fixture.advance(2 * UPDATE_INTERVAL); await fixture.scheduler.resume();
  assert.deepEqual(fixture.calls, ['check', 'download']);
  assert.equal(fixture.view.status, 'downloaded');
  assert.equal(fixture.scheduler.state().nextCheckAt, null);
  assert.equal(fixture.scheduler.state().waitingForIdle, false);
  await fixture.scheduler.setPreferences({ automaticUpdates: true });
  await fixture.fire();
  assert.equal(fixture.calls.at(-1)[0], 'install');
  fixture.scheduler.stop();
});

test('disabled preference keeps explicit checks, with no implicit download', async () => {
  const fixture = schedulerFixture({ automatic: false, releaseStatus: 'available' });
  await fixture.scheduler.start();
  assert.deepEqual(fixture.calls, []);
  await fixture.scheduler.checkNow();
  assert.deepEqual(fixture.calls, ['check']);
  fixture.scheduler.stop();
});

test('source, ahead and current builds never auto-download or downgrade', async () => {
  for (const options of [{ supported: false, releaseStatus: 'available' }, { releaseStatus: 'ahead' }, { releaseStatus: 'current' }]) {
    const fixture = schedulerFixture(options);
    fixture.environment.idle = true;
    await fixture.scheduler.start();
    assert.deepEqual(fixture.calls, ['check']);
    assert.equal(fixture.scheduler.state().waitingForIdle, false);
    fixture.scheduler.stop();
  }
});

test('resume is single-flight, suspension waits, and shutdown prevents late download', async () => {
  const waiting = deferred(), began = deferred();
  const fixture = schedulerFixture({ releaseStatus: 'available', check: () => { began.resolve(); return waiting.promise; } });
  const startup = fixture.scheduler.start(); await began.promise;
  const resume = fixture.scheduler.resume();
  fixture.scheduler.stop(); waiting.resolve();
  await Promise.all([startup, resume]);
  assert.deepEqual(fixture.calls, ['check']);
  assert.equal(fixture.timer(), undefined);
  const suspended = schedulerFixture();
  suspended.environment.suspended = true;
  await suspended.scheduler.start();
  assert.deepEqual(suspended.calls, []);
  suspended.environment.suspended = false;
  await suspended.scheduler.resume();
  assert.deepEqual(suspended.calls, ['check']);
  suspended.scheduler.stop();
});

test('check failures remain visible and are not repeated at every idle tick', async () => {
  const fixture = schedulerFixture({ check: () => { throw new Error('offline'); } });
  await fixture.scheduler.start();
  assert.notEqual(fixture.scheduler.state().error, null);
  fixture.view.status = 'error';
  await fixture.fire();
  assert.deepEqual(fixture.calls, ['check']);
  fixture.scheduler.stop();
});

test('preferences default on, persist separately, and validate exact local input', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'rr-update-preferences-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const preferences = createUpdatePreferences(directory);
  assert.deepEqual(await preferences.load(), { automaticUpdates: true });
  await preferences.save({ automaticUpdates: false });
  assert.deepEqual(await createUpdatePreferences(directory).load(), { automaticUpdates: false });
  assert.deepEqual(JSON.parse(await readFile(path.join(directory, 'preferences.json'), 'utf8')), { automaticUpdates: false });
  if (process.platform !== 'win32') {
    assert.equal((await stat(directory)).mode & 0o777, 0o700);
    assert.equal((await stat(path.join(directory, 'preferences.json'))).mode & 0o777, 0o600);
  }
  for (const value of [null, [], {}, { automaticUpdates: 'true' }, { automaticUpdates: 1 }, { automaticUpdates: true, url: 'https://example.invalid' }])
    assert.throws(() => validateUpdatePreferences(value), { code: 'INVALID_INPUT' });
  await writeFile(path.join(directory, 'preferences.json'), 'not json');
  await assert.rejects(preferences.load());
});

test('unreadable preferences disable automation instead of silently enabling it', async () => {
  let checks = 0;
  const scheduler = createUpdateScheduler({ updates: { state: () => ({ status: 'idle' }), check: () => { checks++; } },
    preferences: { load: () => { throw new Error('bad preferences'); }, save: async () => {} }, install: () => {}, canInstall: () => false,
    setTimer: () => 1, clearTimer: () => {} });
  await scheduler.start();
  assert.equal(checks, 0);
  assert.equal(scheduler.state().enabled, false);
  assert.notEqual(scheduler.state().error, null);
  scheduler.stop();
});

test('preference reads reject symlink files', { skip: process.platform === 'win32' }, async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'rr-update-links-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const preferences = createUpdatePreferences(directory);
  await preferences.load();
  await writeFile(path.join(directory, 'other.json'), '{"automaticUpdates":true}', { mode: 0o600 });
  await symlink(path.join(directory, 'other.json'), path.join(directory, 'preferences.json'));
  await assert.rejects(preferences.load());
});

test('work admission closes atomically, drains accepted requests and honors meaningful quiet time', async () => {
  let time = 0;
  const gate = createUpdateWorkGate({ now: () => time });
  const waiting = deferred();
  const work = gate.run(() => waiting.promise);
  assert.equal(gate.state().active, 1);
  assert.equal(gate.close(), false);
  assert.equal(gate.close({ drain: true }), true);
  await assert.rejects(gate.run(() => {}), { code: 'LOCAL_BUSY' });
  let drained = false;
  const drain = gate.drain().then(() => { drained = true; });
  await turn(); assert.equal(drained, false);
  time = 100; waiting.resolve(); await work; await drain;
  assert.equal(gate.state().lastActivityAt, 100);
  gate.reopen(); time += UPDATE_QUIET_WINDOW;
  assert.equal(gate.quiet(), true);
  await gate.run(() => {}, { meaningful: false });
  assert.equal(gate.quiet(), true, 'status polling is not meaningful activity');
  await gate.run(() => {});
  assert.equal(gate.quiet(), false, 'MCP reads and application work extend the quiet window');
  assert.equal(gate.close(), true);
  await assert.rejects(gate.run(() => {}), { code: 'LOCAL_BUSY' });
});

test('app targets derive only from supported packaged runtime paths', () => {
  assert.equal(updateAppPath({ packaged: true, platform: 'darwin', executable: '/Applications/Companion.app/Contents/MacOS/Companion' }), '/Applications/Companion.app');
  assert.equal(updateAppPath({ packaged: true, platform: 'win32', executable: 'C:\\Users\\Test\\Companion\\Companion.exe' }), 'C:\\Users\\Test\\Companion');
  assert.equal(updateAppPath({ packaged: true, platform: 'linux', executable: '/tmp/.mount_companion/companion', appImage: '/home/test/Companion.AppImage' }), '/home/test/Companion.AppImage');
  for (const options of [{ packaged: false, platform: 'darwin' }, { packaged: true, localOnly: true, platform: 'darwin' }, { packaged: true, platform: 'linux', appImage: 'relative.AppImage' }, { packaged: true, platform: 'linux' }, { packaged: true, platform: 'freebsd' }])
    assert.equal(updateAppPath(options), null);
});

const mainSource = await readFile(new URL('../src/main.mjs', import.meta.url), 'utf8');
function mainFixture({ stage = async () => {} } = {}) {
  let time = 0, focused = false, idleSeconds = 300, installs = 0, flushed = 0;
  const view = { status: 'downloaded', automaticSupported: true };
  const workGate = createUpdateWorkGate({ now: () => time });
  time = UPDATE_QUIET_WINDOW;
  const context = vm.createContext({
    updateInstalling: false, updateInstallTask: undefined, quitDraining: false, sleeping: false, restoringBackup: false,
    pendingApproval: undefined, initializing: undefined, vaultOpened: true, locked: false, mutations: new Set(), formRequests: new Map(), browserReplies: new Map(),
    workGate, window: { isDestroyed: () => false, isFocused: () => focused }, powerMonitor: { getSystemIdleTime: () => idleSeconds },
    updateScheduler: { state: () => ({ enabled: true }), stop() {}, async settled() {} },
    updates: {
      state: () => ({ ...view }),
      async install(options) {
        view.status = 'staging';
        await stage();
        const admission = await context.acquireInstallAdmission(options);
        if (!admission?.valid()) {
          admission?.release(); view.status = 'downloaded';
          return { ...view };
        }
        installs++; view.status = 'installing';
        return { ...view };
      },
      async cancel() { view.status = 'cancelled'; },
    },
    vault: { async flush() { flushed++; } }, fail, emit() {}, assertAvailable() {}, shell: { showItemInFolder() { throw new Error('Unexpected automatic reveal'); }, openPath() { throw new Error('Unexpected automatic open'); } },
  });
  vm.runInContext(mainSource.slice(mainSource.indexOf('function updateState()'), mainSource.indexOf('async function startUpdates()')), context);
  return { context, view, gate: workGate, installs: () => installs, flushed: () => flushed,
    focus: value => { focused = value; }, idle: value => { idleSeconds = value; }, advance: value => { time += value; } };
}

test('main install guard rejects active form, mutation, dialog, restore, focus and recent input', async () => {
  const fixture = mainFixture(), { context } = fixture;
  for (const field of ['pendingApproval', 'restoringBackup', 'initializing']) {
    context[field] = true;
    assert.equal(await context.installUpdate({ automatic: true }), false);
    context[field] = undefined;
  }
  for (const collection of ['mutations', 'formRequests', 'browserReplies']) {
    if (context[collection] instanceof Set) context[collection].add('active'); else context[collection].set('active', true);
    assert.equal(await context.installUpdate({ automatic: true }), false);
    context[collection].clear();
  }
  fixture.focus(true); assert.equal(await context.installUpdate({ automatic: true }), false); fixture.focus(false);
  fixture.idle(0); assert.equal(await context.installUpdate({ automatic: true }), false); fixture.idle(300);
  fixture.gate.activity(); assert.equal(await context.installUpdate({ automatic: true }), false);
  assert.equal(fixture.installs(), 0);
  fixture.advance(UPDATE_QUIET_WINDOW);
  assert.equal(await context.installUpdate({ automatic: true }), true);
  assert.equal(fixture.installs(), 1);
  assert.equal(fixture.gate.state().closed, true, 'the gate stays closed after handoff');
});

test('main closes admission before flush and rechecks activity before handoff', async () => {
  const fixture = mainFixture(), waiting = deferred(), began = deferred();
  fixture.context.vault.flush = () => { began.resolve(); return waiting.promise; };
  const installing = fixture.context.installUpdate({ automatic: true });
  await began.promise;
  await assert.rejects(fixture.gate.run(() => {}), { code: 'LOCAL_BUSY' });
  fixture.focus(true); waiting.resolve();
  assert.equal(await installing, false);
  assert.equal(fixture.installs(), 0);
  assert.equal(fixture.gate.state().closed, false);
});

test('main does not open manual fallback files during an automatic cycle', async () => {
  const fixture = mainFixture();
  fixture.context.updates.install = async () => { fixture.view.status = 'manual-required'; return { manualPath: '/synthetic/update', reveal: true }; };
  await fixture.context.installUpdate({ automatic: true });
  assert.equal(fixture.gate.state().closed, false);
});

function attachQuit(fixture) {
  const { context } = fixture;
  let handler, quits = 0, settled = 0;
  const exits = [], events = [], flush = context.vault.flush;
  context.vault.flush = async () => { await flush(); events.push('flushed'); };
  Object.assign(context, { exiting: false, heartbeatTimer: undefined,
    pairingReturn: { close() { events.push('pairing-closed'); } },
    mcpBridge: { close() { events.push('mcp-closed'); } }, nativeBridge: { close() { events.push('native-closed'); } },
    sockets: new Set([{ destroy() { events.push('socket-destroyed'); } }]), browserForms: { cancelAll() {} }, clearInterval() {}, failure: '',
    app: { on(_event, callback) { handler = callback; }, quit() { quits++; handler({ preventDefault() {} }); },
      exit(code) { events.push('exit'); exits.push(code); } } });
  context.updateScheduler.settled = async () => { settled++; await context.updateInstallTask; };
  const start = mainSource.indexOf("  app.on('before-quit', event => {");
  vm.runInContext(mainSource.slice(start, mainSource.indexOf('  void app.whenReady()', start)), context);
  return { quits: () => quits, settled: () => settled, exits, events };
}

test('updater quit handoff never waits on its own scheduler/install promise', async () => {
  const fixture = mainFixture(), quit = attachQuit(fixture);
  const install = fixture.context.updates.install;
  fixture.context.updates.install = async options => {
    const result = await install(options);
    if (result.status === 'installing') fixture.context.app.quit();
    return result;
  };
  await fixture.context.installUpdate({ automatic: true });
  await turn();
  assert.equal(fixture.context.exiting, true);
  assert.equal(quit.quits(), 1);
  assert.deepEqual(quit.exits, [0]);
  assert.deepEqual(quit.events.slice(-6), ['flushed', 'pairing-closed', 'mcp-closed', 'native-closed', 'socket-destroyed', 'exit']);
  assert.equal(quit.settled(), 0);
});

test('ordinary quit saves career work without waiting for a background update', async () => {
  const fixture = mainFixture(), quit = attachQuit(fixture), waiting = deferred(), update = deferred();
  fixture.context.updates.cancel = () => { fixture.view.status = 'cancelled'; return update.promise; };
  fixture.context.updateInstallTask = update.promise;
  fixture.view.status = 'downloading';
  const work = fixture.gate.run(() => waiting.promise);
  fixture.context.app.quit();
  await turn();
  assert.equal(fixture.view.status, 'cancelled');
  assert.deepEqual(quit.exits, []);
  await assert.rejects(fixture.gate.run(() => {}), { code: 'LOCAL_BUSY' });
  waiting.resolve(); await work; await turn();
  assert.equal(fixture.context.exiting, true);
  assert.equal(quit.quits(), 1);
  assert.deepEqual(quit.exits, [0]);
  assert.deepEqual(quit.events, ['flushed', 'pairing-closed', 'mcp-closed', 'native-closed', 'socket-destroyed', 'exit']);
  assert.equal(quit.settled(), 0);
  update.resolve();
});

test('only local settings exposes strictly boolean update preferences', async () => {
  let companion;
  const calls = [];
  const context = vm.createContext({ require: name => {
    assert.equal(name, 'electron');
    return { contextBridge: { exposeInMainWorld(_name, value) { companion = value; } }, ipcRenderer: { invoke: (...args) => { calls.push(args); return Promise.resolve(); } } };
  } });
  vm.runInContext(await readFile(new URL('../src/preload.cjs', import.meta.url), 'utf8'), context);
  await companion.invoke('update-preferences', { automaticUpdates: false });
  assert.deepEqual(calls[0], ['local-settings', 'update-preferences', { automaticUpdates: false }]);
  for (const value of [{}, null, [], { automaticUpdates: 'false' }, { automaticUpdates: true, target: '/other/app' }])
    await assert.rejects(companion.invoke('update-preferences', value));
  assert.equal(calls.length, 1);
  const native = mainSource.slice(mainSource.indexOf('async function nativeOperation('), mainSource.indexOf('// The extension that prepared a form'));
  assert.doesNotMatch(native, /update-preferences|update-install|update-download/);
  assert.match(mainSource, /event\.senderFrame !== window\.webContents\.mainFrame/);
  assert.match(mainSource, /event\.senderFrame\.url !== uiURL/);
});

test('background check and download do not block active form work', async () => {
  const fixture = mainFixture(), calls = [];
  fixture.context.formRequests.set('synthetic-form-request', true);
  fixture.context.updateScheduler.checkNow = async () => { calls.push('check'); };
  fixture.context.updates.download = async () => { calls.push('download'); fixture.view.status = 'downloading'; };
  await fixture.context.updateAction('update-check');
  await fixture.context.updateAction('update-download');
  await fixture.gate.run(() => { calls.push('form-work'); });
  assert.deepEqual(calls, ['check', 'download', 'form-work']);
  assert.equal(fixture.gate.state().closed, false);
});

test('update confirmation waits for core readiness and successful local initialization', async () => {
  const calls = [];
  const context = vm.createContext({ coreReady: false, locked: true, updatesStarted: false, quitDraining: false,
    updates: { async initialize() { calls.push('confirm-ready'); } }, updateScheduler: { async start() { calls.push('schedule'); } } });
  vm.runInContext(mainSource.slice(mainSource.indexOf('async function startUpdates()'), mainSource.indexOf('function assertStorageAvailable()')), context);
  await context.startUpdates();
  context.coreReady = true; await context.startUpdates();
  assert.deepEqual(calls, []);
  context.locked = false; await context.startUpdates(); await context.startUpdates();
  assert.deepEqual(calls, ['confirm-ready', 'schedule']);
});

test('unknown OS idle capability falls back to meaningful quiet time, never to focused restart', async () => {
  const fixture = mainFixture();
  fixture.context.powerMonitor.getSystemIdleState = () => 'unknown';
  fixture.idle(0);
  fixture.focus(true);
  assert.equal(await fixture.context.installUpdate({ automatic: true }), false);
  fixture.focus(false);
  assert.equal(await fixture.context.installUpdate({ automatic: true }), true);
});

test('a queued manual check cannot start another cycle after shutdown', async () => {
  const waiting = deferred(), began = deferred();
  const fixture = schedulerFixture({ check: () => { began.resolve(); return waiting.promise; } });
  const startup = fixture.scheduler.start(); await began.promise;
  const manual = fixture.scheduler.checkNow();
  const rejected = assert.rejects(manual, { code: 'LOCAL_BUSY' });
  fixture.scheduler.stop(); waiting.resolve();
  await startup; await rejected;
  assert.deepEqual(fixture.calls, ['check']);
});

test('enabling automatic updates downloads an already discovered release without rechecking', async () => {
  const fixture = schedulerFixture({ automatic: false, releaseStatus: 'available' });
  await fixture.scheduler.start(); await fixture.scheduler.checkNow();
  await fixture.scheduler.setPreferences({ automaticUpdates: true });
  await fixture.fire();
  assert.deepEqual(fixture.calls, ['check', 'download']);
  assert.equal(fixture.scheduler.state().waitingForIdle, true);
  fixture.scheduler.stop();
});

test('staging admits ordinary work and rechecks every final automatic-restart condition', async () => {
  for (const changed of ['focus', 'activity', 'preference', 'lock', 'suspend', 'os-idle']) {
    const staged = deferred(), ready = deferred();
    const fixture = mainFixture({ stage: () => { staged.resolve(); return ready.promise; } });
    const installing = fixture.context.installUpdate({ automatic: true });
    await staged.promise;
    assert.equal(fixture.gate.state().closed, false, changed);
    assert.equal(fixture.context.updateInstalling, false, changed);
    await fixture.gate.run(() => {}, { meaningful: false });
    if (changed === 'focus') fixture.focus(true);
    if (changed === 'activity') fixture.gate.activity();
    if (changed === 'preference') fixture.context.updateScheduler.state = () => ({ enabled: false });
    if (changed === 'lock') fixture.context.locked = true;
    if (changed === 'suspend') fixture.context.sleeping = true;
    if (changed === 'os-idle') fixture.idle(0);
    ready.resolve();
    assert.equal(await installing, false, changed);
    assert.equal(fixture.installs(), 0, changed);
    assert.equal(fixture.view.status, 'downloaded', changed);
    assert.equal(fixture.gate.state().closed, false, changed);
  }
});

test('a job accepted during staging is never interrupted by the pending update', async () => {
  const staged = deferred(), ready = deferred(), job = deferred();
  const fixture = mainFixture({ stage: () => { staged.resolve(); return ready.promise; } });
  const installing = fixture.context.installUpdate({ automatic: true });
  await staged.promise;
  const active = fixture.gate.run(() => job.promise);
  ready.resolve();
  assert.equal(await installing, false);
  assert.equal(fixture.installs(), 0);
  assert.equal(fixture.gate.state().active, 1);
  job.resolve('saved');
  assert.equal(await active, 'saved');
  assert.equal(fixture.view.status, 'downloaded');
});

test('final admission remains synchronously revocable until helper commit', async () => {
  const fixture = mainFixture();
  const admission = await fixture.context.acquireInstallAdmission({ automatic: true });
  assert.equal(admission.valid(), true);
  fixture.focus(true);
  assert.equal(admission.valid(), false);
  admission.release(); admission.release();
  assert.equal(fixture.gate.state().closed, false);
  assert.equal(fixture.context.updateInstalling, false);
});

test('failed final flush reopens admission without committing an update', async () => {
  const fixture = mainFixture();
  const failure = new Error('Synthetic flush failure');
  fixture.context.vault.flush = async () => { throw failure; };
  await assert.rejects(fixture.context.installUpdate({ automatic: true }), error => error === failure);
  assert.equal(fixture.gate.state().closed, false);
  assert.equal(fixture.context.updateInstalling, false);
  assert.equal(fixture.installs(), 0);
});

function startupFixture({ target = '/synthetic/Companion.app', source = null, claim = async () => () => {} } = {}) {
  const calls = [];
  const context = vm.createContext({
    binaryInstallationTarget: target, localOnly: false, app: { isPackaged: Boolean(target) },
    root: '/synthetic/managed/versions/3.12.0', packageMetadata: { version: '3.12.0' }, managedSource: null,
    quitDraining: false, installationAdmitted: false, releaseInstallation: undefined,
    inspectManagedSource: async (root, options) => { calls.push(['inspect', root, options.version]); return source; },
    claimInstallation: async target => { calls.push(['claim', target]); return claim(target); },
  });
  vm.runInContext(mainSource.slice(mainSource.indexOf('async function admitInstallationStartup()'), mainSource.indexOf('async function startUpdates()')), context);
  return { context, calls };
}

test('startup refuses competing installation ownership before opening any app surface', async () => {
  const { context, calls } = startupFixture({ claim: async () => null });
  assert.equal(await context.admitInstallationStartup(), false);
  assert.equal(context.installationAdmitted, false);
  assert.deepEqual(calls, [['claim', '/synthetic/Companion.app']]);
  vm.runInContext(mainSource.slice(mainSource.indexOf('function showSettings()'), mainSource.indexOf('async function showDecisionsSettings()')), context);
  context.BrowserWindow = class { constructor() { assert.fail('Window opened before installation exclusion'); } };
  context.showSettings();
  assert.ok(mainSource.indexOf('if (!await admitInstallationStartup())') < mainSource.indexOf('if (!await claimInstance(directory))'));
});

test('startup retains installation lease for process lifetime and rejects unknown lock failures', async () => {
  let releases = 0;
  const held = startupFixture({ claim: async () => () => { releases++; } });
  assert.equal(await held.context.admitInstallationStartup(), true);
  assert.equal(typeof held.context.releaseInstallation, 'function');
  assert.equal(releases, 0);
  const failed = startupFixture({ claim: async () => { throw Object.assign(new Error('unsafe lock'), { code: 'EINVAL' }); } });
  await assert.rejects(failed.context.admitInstallationStartup(), { code: 'EINVAL' });
  assert.equal(failed.context.installationAdmitted, false);
});

test('read-only installation startup is allowed without pretending its lock was acquired', async () => {
  const { context } = startupFixture({ claim: async () => { throw Object.assign(new Error('read only'), { code: 'EROFS' }); } });
  assert.equal(await context.admitInstallationStartup(), true);
  assert.equal(context.releaseInstallation, undefined);
});

test('managed source startup binds exclusion to its validated stable root, not a version folder or environment flag', async () => {
  const managed = startupFixture({ target: null, source: { root: '/synthetic/managed', sourceRoot: '/synthetic/managed/versions/3.12.0' } });
  assert.equal(await managed.context.admitInstallationStartup(), true);
  assert.deepEqual(managed.calls, [['inspect', '/synthetic/managed/versions/3.12.0', '3.12.0'], ['claim', '/synthetic/managed']]);
  const unmanaged = startupFixture({ target: null });
  assert.equal(await unmanaged.context.admitInstallationStartup(), true);
  assert.deepEqual(unmanaged.calls, [['inspect', '/synthetic/managed/versions/3.12.0', '3.12.0']]);
  assert.equal(unmanaged.context.managedSource, null);
});

test('an in-flight preference save prevents final automatic admission before disk completion', async () => {
  const fixture = mainFixture(), saving = deferred();
  const scheduler = createUpdateScheduler({
    updates: { state: () => ({ status: 'downloaded', automaticSupported: true }) },
    preferences: { load: async () => ({ automaticUpdates: true }), save: () => saving.promise },
    install: () => {}, canInstall: () => false, setTimer: () => 1, clearTimer: () => {},
  });
  await scheduler.start();
  fixture.context.updateScheduler = scheduler;
  const pending = scheduler.setPreferences({ automaticUpdates: false });
  assert.equal(scheduler.state().preferencePending, true);
  assert.equal(await fixture.context.acquireInstallAdmission({ automatic: true }), null);
  assert.equal(fixture.gate.state().closed, false);
  saving.resolve(); await pending;
  assert.equal(scheduler.state().preferencePending, false);
  assert.equal(scheduler.state().enabled, false);
  scheduler.stop();
});

test('source setup opens only the fixed official migration guide', async () => {
  const fixture = mainFixture(), opened = [];
  fixture.context.shell.openExternal = async url => { opened.push(url); };
  await fixture.context.updateAction('update-source-guide');
  assert.deepEqual(opened, ['https://recruiters.rip/downloads#source-install']);
});

test('Save to Downloads creates the managed folder; launches refresh only saved folders and advertise after the copy', async () => {
  for (const localOnly of [false, true]) {
    let record = null, copied = deferred(), copying = deferred();
    const calls = [], downloads = '/synthetic/Downloads', directory = '/synthetic/profile/device';
    const context = vm.createContext({
      root: '/synthetic/source', directory, app: { isPackaged: false, getPath: name => { assert.equal(name, 'downloads'); return downloads; } }, localOnly, path,
      packageMetadata: { version: '3.12.0' }, browserIdentity: { key: 'synthetic-key' }, browserExtensions: {}, fail,
      readFile: async () => JSON.stringify({ version: '3.12.0', key: 'synthetic-key' }),
      privateJSON: () => { if (!record) throw Object.assign(new Error('missing'), { code: 'ENOENT' }); return JSON.parse(record); },
      writeFile: async (file, data) => { assert.equal(file, path.join(directory, 'browser-extension-folders.json')); record = data; },
      protectPrivatePath: () => {},
      persistBrowserExtension: options => { calls.push(options); copying.resolve(); return copied.promise; },
    });
    vm.runInContext(mainSource.slice(mainSource.indexOf('async function refreshBrowserExtension('), mainSource.indexOf('async function nativeOperation(')), context);
    assert.equal(await context.refreshBrowserExtension('chrome'), null, 'nothing saved: launch leaves Downloads alone');
    assert.equal(calls.length, 0);
    const folder = path.join(downloads, `Recruiters.rip Chrome extension${localOnly ? ' (local)' : ''}`);
    const saving = context.refreshBrowserExtension('chrome', true);
    await copying.promise;
    assert.deepEqual({ ...calls[0] }, { source: path.join('/synthetic/source', 'browser-extension', 'dist', localOnly ? 'local' : 'production'), destination: folder, create: true });
    assert.equal(context.browserExtensions.chrome, undefined);
    copied.resolve(folder);
    assert.equal(await saving, folder);
    assert.deepEqual({ ...context.browserExtensions.chrome }, { managed: true, version: '3.12.0' });
    assert.deepEqual(JSON.parse(record), { chrome: folder });
    copied = deferred(); copying = deferred();
    const launching = context.refreshBrowserExtension('chrome');
    await copying.promise;
    assert.equal(calls[1].destination, folder); assert.equal(calls[1].create, false);
    copied.resolve(folder); assert.equal(await launching, folder);
  }
});
