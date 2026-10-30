const ALARM = 'managed-extension-update';
const ATTEMPT = 'managedExtensionReloadAttempt';
const versionParts = value => typeof value === 'string' && /^\d+\.\d+\.\d+(?:\.\d+)?$/.test(value) ? value.split('.').map(Number) : null;
function newer(candidate, current) {
  const a = versionParts(candidate), b = versionParts(current);
  if (!a || !b) return false;
  for (let i = 0; i < 4; i++) { if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0); }
  return false;
}

// The marker is present only in the Downloads folder Companion saves and refreshes, never source ZIPs.
// No candidate state is persisted; a version-only receipt prevents failed reload loops.
export function installManagedUpdates({ browser, browserName, status, isSafe, fetchImpl = fetch }) {
  let checking = false;
  async function check() {
    if (checking || !isSafe()) return;
    checking = true;
    try {
      const installed = browser.runtime.getManifest().version;
      const companion = await status();
      const managed = companion?.browserExtensions?.[browserName];
      if (!managed?.managed || !newer(managed.version, installed) || !isSafe()) return;
      const response = await fetchImpl(browser.runtime.getURL('managed-update.json'), { cache: 'no-store' });
      if (!response.ok) return;
      const marker = await response.json();
      if (marker.version !== managed.version) return;
      const receipt = await browser.storage.local.get(ATTEMPT);
      if (receipt[ATTEMPT] === managed.version) return;
      if (!['idle', 'locked'].includes(await browser.idle.queryState(300)) || !isSafe()) return;
      await browser.storage.local.set({ [ATTEMPT]: managed.version });
      if (!isSafe()) { await browser.storage.local.remove(ATTEMPT); return; }
      browser.runtime.reload();
    } catch { /* Closed Companion, missing managed folder or browser denial: retry on a later alarm. */ }
    finally { checking = false; }
  }
  browser.alarms.onAlarm.addListener(alarm => { if (alarm.name === ALARM) void check(); });
  void browser.alarms.create(ALARM, { delayInMinutes: 1, periodInMinutes: 5 });
  return { check };
}
