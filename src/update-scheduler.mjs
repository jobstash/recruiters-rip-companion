import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { assertPrivatePath, protectPrivatePath } from './platform-runtime.cjs';
import { fail } from './mcp/state.mjs';

export const UPDATE_INTERVAL = 30 * 60 * 1000;
export const UPDATE_QUIET_WINDOW = 5 * 60 * 1000;
const BUSY = new Set(['checking', 'downloading', 'staging', 'installing', 'launched']);

export function updateAppPath({ packaged, localOnly = false, platform, executable, appImage }) {
  if (!packaged || localOnly) return null;
  if (platform === 'darwin') return path.posix.resolve(executable, '../../..');
  if (platform === 'win32') return path.win32.dirname(executable);
  if (platform === 'linux' && typeof appImage === 'string' && path.posix.isAbsolute(appImage)) return appImage;
  return null;
}

export function validateUpdatePreferences(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 1 || typeof value.automaticUpdates !== 'boolean' || !Object.hasOwn(value, 'automaticUpdates'))
    fail('INVALID_INPUT', 'Choose whether to keep the app up to date.');
  return { automaticUpdates: value.automaticUpdates };
}

// This setting deliberately lives outside the career store and its backups.
export function createUpdatePreferences(directory) {
  const filename = path.join(directory, 'preferences.json');
  let writes = Promise.resolve();
  async function prepare() {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    protectPrivatePath(directory, { directory: true });
  }
  return {
    async load() {
      await prepare();
      try {
        assertPrivatePath(filename, { info: await lstat(filename), maxSize: 1024 });
        return validateUpdatePreferences(JSON.parse(await readFile(filename, 'utf8')));
      } catch (error) { if (error.code === 'ENOENT') return { automaticUpdates: true }; throw error; }
    },
    save(input) {
      const value = validateUpdatePreferences(input);
      const pending = writes.then(async () => {
        await prepare();
        const temporary = `${filename}.${randomUUID()}.tmp`;
        try {
          await writeFile(temporary, JSON.stringify(value), { mode: 0o600, flag: 'wx' });
          protectPrivatePath(temporary);
          await rename(temporary, filename);
        } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
        return value;
      });
      writes = pending.catch(() => {});
      return pending;
    },
    async flush() { await writes; },
  };
}

// Admission and the idle decision are synchronous: a new request cannot slip
// between finding no work and closing the gate for a restart.
export function createUpdateWorkGate({ now = Date.now } = {}) {
  const pending = new Set();
  let closed = false, lastActivityAt = now();
  const activity = () => { lastActivityAt = now(); };
  return {
    activity,
    state: () => ({ closed, active: pending.size, lastActivityAt }),
    async run(action, { meaningful = true } = {}) {
      if (closed) fail('LOCAL_BUSY', 'The companion is restarting or closing. Wait for it to reopen.');
      if (meaningful) activity();
      const work = Promise.resolve().then(action);
      pending.add(work);
      try { return await work; }
      finally { pending.delete(work); if (meaningful) activity(); }
    },
    close({ drain = false } = {}) {
      if (closed || (!drain && pending.size)) return false;
      closed = true;
      return true;
    },
    reopen() { closed = false; },
    async drain() { while (pending.size) await Promise.allSettled([...pending]); },
    quiet() { return now() - lastActivityAt >= UPDATE_QUIET_WINDOW; },
  };
}

export function createUpdateScheduler({ updates, preferences, install, canInstall, suspended = () => false, onChange = () => {}, now = Date.now,
  setTimer = setTimeout, clearTimer = clearTimeout }) {
  let enabled = true, started = false, stopped = false, timer, operation, preferenceWrite = Promise.resolve();
  let lastCheckedAt = null, nextCheckAt = null, waitingForIdle = false, error = null, pendingPreferences = 0;
  const state = () => ({ enabled, lastCheckedAt, nextCheckAt: enabled && !stopped ? nextCheckAt : null, waitingForIdle, error, preferencePending: pendingPreferences > 0 });
  const emit = () => onChange(state());
  function waiting(value) { if (waitingForIdle !== value) { waitingForIdle = value; emit(); } }
  function schedule() {
    clearTimer(timer);
    if (!started || stopped) return;
    timer = setTimer(() => { void tick(); }, 60_000);
    timer?.unref?.();
  }
  async function check() {
    if (stopped) return;
    lastCheckedAt = now(); nextCheckAt = lastCheckedAt + UPDATE_INTERVAL; error = null; emit();
    await updates.check();
    if (!stopped && enabled && updates.state().automaticSupported === true && updates.state().status === 'available') await updates.download();
  }
  async function pendingInstall() {
    const view = updates.state();
    if (!enabled || stopped || suspended() || view.automaticSupported !== true || view.status !== 'downloaded') { waiting(false); return; }
    waiting(true);
    if (!canInstall()) return;
    error = null; waiting(false);
    await install({ automatic: true });
    waiting(updates.state().status === 'downloaded' && enabled && !stopped);
  }
  function run(action) {
    if (operation) return operation;
    operation = Promise.resolve().then(action).catch(cause => {
      // Engine errors already have a public status. Lifecycle/preference errors
      // need their own visible recovery rather than an unhandled timer rejection.
      error = cause?.publicUpdateError ? cause.message : updates.state().status === 'downloaded'
        ? 'The app could not prepare to restart. Try Restart now.'
        : 'Automatic updates could not finish. Check now to try again.';
      emit();
    }).finally(() => { operation = undefined; schedule(); });
    return operation;
  }
  function tick() {
    return run(async () => {
      if (!started || stopped || !enabled || suspended()) { waiting(false); return; }
      const view = updates.state();
      if (BUSY.has(view.status) || view.status === 'manual-required') return;
      // Never discard a verified download just because another check is due.
      if (view.status === 'available' && view.automaticSupported === true) await updates.download();
      else if (view.status !== 'downloaded' && (nextCheckAt === null || now() >= nextCheckAt)) await check();
      await pendingInstall();
    });
  }
  return {
    state,
    async start() {
      if (started || stopped) return;
      try { enabled = (await preferences.load()).automaticUpdates; }
      catch { enabled = false; error = 'The update preference could not be read. Choose your preference again.'; }
      started = true; nextCheckAt = now(); emit();
      return tick();
    },
    resume: tick,
    async checkNow() {
      if (stopped) fail('LOCAL_BUSY', 'The companion is closing.');
      if (!started) fail('LOCAL_BUSY', 'Updates are starting. Try again shortly.');
      if (operation) await operation;
      if (stopped) fail('LOCAL_BUSY', 'The companion is closing.');
      if (updates.state().status === 'downloaded') return updates.state();
      await run(check);
      return updates.state();
    },
    setPreferences(input) {
      const value = validateUpdatePreferences(input);
      pendingPreferences++; emit();
      const pending = preferenceWrite.then(async () => {
        if (stopped) fail('LOCAL_BUSY', 'The companion is closing.');
        await preferences.save(value);
        enabled = value.automaticUpdates; error = null;
        if (!enabled) waiting(false);
        else if (nextCheckAt === null) nextCheckAt = now();
        emit(); schedule();
      }).finally(() => { pendingPreferences--; emit(); });
      preferenceWrite = pending.catch(() => {});
      return pending.then(state);
    },
    stop() { stopped = true; waiting(false); clearTimer(timer); },
    async settled() { await operation; await preferenceWrite; await preferences.flush?.(); },
  };
}
