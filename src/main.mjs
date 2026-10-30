import { app, BrowserWindow, ipcMain, powerMonitor, Menu, shell, clipboard, dialog, safeStorage } from 'electron';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile, realpath, writeFile, chmod, unlink, mkdir } from 'node:fs/promises';
import { watch, existsSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createVault, privateDirectory, LEGACY_VAULT } from './vault.mjs';
import { createBackups } from './backup.mjs';
import { createDeviceClient } from './client.mjs';
import { installNative } from './install-native.mjs';
import { BROWSER_IDENTITIES, nativeBrowser } from './browser-identity.mjs';
import { claimInstance } from './instance-lock.mjs';
import { endpoint, launcherScript, mcpCommand, protectPrivatePath, privateJSON, createAuthenticationChallenge, verifyAuthenticationProof, prepareBridgeRuntime, persistBrowserExtension } from './platform-runtime.cjs';
import { createIntroductionTools, introductionsStatus, setSharingConsent } from './mcp/introduction-tools.mjs';
import { deleteCv } from './mcp/cv-deletion.mjs';
import { openEmploymentProfile } from './employment-browser.mjs';
import { openJobPage, requirementContextPrompt } from './career-browser.mjs';
import { EXTENSIONS_PAGES, openExtensionsPage } from './browser-page.mjs';
import { CareerError, createCareerState, fail, hash, upgradeCareer } from './mcp/state.mjs';
import { createMcpServer, createPlatformTools } from './mcp/server.mjs';
import { createProfileTools } from './mcp/profile-tools.mjs';
import { createApplicationTools } from './mcp/application-tools.mjs';
import { startMcpBroker } from './mcp/broker.mjs';
import { createDocumentFiles, readSelectedSource } from './mcp/files.mjs';
import { createScopedAccess } from './mcp/scope.mjs';
import { createMatchingTools, deleteRankings } from './mcp/matching-tools.mjs';
import { matchingProfileVersion } from './mcp/assessment-policy.mjs';
import { addBlock, removeBlock } from './mcp/blocklist.mjs';
import { addedHosts, agentSetupPrompt, installChatGptPlugin, prepareClaudePackage } from './host-setup.mjs';
import { createCareerBrowser } from './career-browser.mjs';
import { createDecisionCredentials, decisionCredentialStatus } from './decisions/credentials.mjs';
import { savedPublicationRange, setPublicationRange } from './mcp/review-queue.mjs';
import { startPairingReturn } from './pairing-return.mjs';
import { createJobTools } from './mcp/job-tools.mjs';
import { createFormTools, currentForm, formEvidence } from './mcp/form-tools.mjs';
import { createBrowserForms } from './browser-forms.mjs';
import { createUpdateController } from './updates.mjs';
import { createUpdatePreferences, createUpdateScheduler, createUpdateWorkGate, updateAppPath } from './update-scheduler.mjs';
import { inspectManagedSource } from './source-updates.mjs';
import { createApplicationWorkflow, createApplicationPreparationTools, saveAppliedJobs } from './application-workflow.mjs';
import { createApplicationLauncher, REVIEW_PROMPT } from './application-launcher.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const packageMetadata = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const localOnly = packageMetadata.localProduct === true || (!app.isPackaged && process.argv.includes('--local-product'));
const browserIdentity = localOnly ? BROWSER_IDENTITIES.local : BROWSER_IDENTITIES.production;
const productOrigin = browserIdentity.productOrigin;
app.setName('Recruiters Companion');
// Keep the storage directory name stable across the visible brand rename.
const directory = path.join(app.getPath('userData'), localOnly ? 'local-device' : 'device');
const updateDirectory = path.join(app.getPath('userData'), localOnly ? 'local-updates' : 'updates');
const binaryInstallationTarget = updateAppPath({ packaged: app.isPackaged, localOnly, platform: process.platform, executable: process.execPath, appImage: process.env.APPIMAGE });
const { claimInstallation } = createRequire(import.meta.url)('./update-install.cjs');
// Local data is plain private JSON; keep Chromium from creating an OS keychain item, except to import a 3.4 keychain-encrypted vault once.
const legacyVault = existsSync(path.join(directory, LEGACY_VAULT));
if (!legacyVault) app.commandLine.appendSwitch('use-mock-keychain');
const uiURL = pathToFileURL(path.join(root, 'ui', 'index.html')).href;
const vault = createVault(directory, legacyVault ? { decryptLegacy: encrypted => safeStorage.decryptString(encrypted) } : {});
let window, client, nativeBridge, mcpBridge, documents, files, locked = true, failure = '', mcpClients = [];
let pendingApproval, confirmation = Promise.resolve(), initializing, exiting = false, screenLocked = false, sleeping = false;
let heartbeatTimer, heartbeatBusy = false, browserConnection = 'pending', queuedPairing, pairingReturn;
let browserRegistrations = { chrome: false, firefox: false };
const browserExtensions = {};
let sessionEpoch = 0, careerViewRevision = 0;
let windowLoaded;
const sockets = new Set();
const mutations = new Set(), formRequests = new Map();
let updateInstalling = false, quitDraining = false, vaultOpened = false;
let browserForms, updates, updateScheduler, updateInstallTask;
let coreReady = false, updatesStarted = false, managedSource = null;
// Retain the installation lease until OS process exit, not merely before-quit.
let installationAdmitted = false, releaseInstallation;
const workGate = createUpdateWorkGate();
let restoringBackup = false;
const identityKey = state => JSON.stringify([state.deviceId, state.pairing?.origin, state.pairing?.account?.id]);
const store = {
  get() { assertAvailable(false); return vault.get(); },
  update(change) {
    assertAvailable(false);
    const generation = sessionEpoch;
    return vault.update(async state => {
      assertAvailable(false);
      if (generation !== sessionEpoch) fail('IDENTITY_CHANGED', 'The profile changed. Reopen it before saving.');
      const identity = identityKey(state);
      await change(state);
      assertAvailable(false);
      if (generation !== sessionEpoch) fail('IDENTITY_CHANGED', 'The profile changed. Reopen it before saving.');
      if (identityKey(state) !== identity) { browserForms?.cancelAll(); sessionEpoch++; }
    });
  },
};
function assertWorkAllowed() {
  assertAvailable(false);
  if (updateInstalling || quitDraining) fail('LOCAL_BUSY', 'An update or shutdown is in progress. Wait for the companion to reopen.');
}
async function mutation(action) {
  assertWorkAllowed();
  const pending = workGate.run(() => action(pending));
  mutations.add(pending);
  try { return await pending; } finally { mutations.delete(pending); }
}
const decisionCredentials = createDecisionCredentials({ store, onChange: async () => { browserForms?.cancelAll(); emit(); } });
browserForms = createBrowserForms({ store, credentials: decisionCredentials, assertAvailable });
const backups = createBackups({
  directory, store: vault, assertAvailable: assertStorageAvailable, epoch: () => sessionEpoch,
  selectBackup: async () => {
    const selected = await dialog.showOpenDialog(window, { title: 'Restore backup', properties: ['openFile'], filters: [{ name: 'Profile backup', extensions: ['json'] }] });
    return selected.canceled ? null : selected.filePaths[0];
  },
  selectDestination: async defaultPath => {
    const selected = await dialog.showSaveDialog(window, { title: 'Save backup', defaultPath, filters: [{ name: 'Profile backup', extensions: ['json'] }] });
    return selected.canceled ? null : selected.filePath;
  },
  openFolder: async folder => { if (await shell.openPath(folder)) fail('BACKUP_FOLDER_UNAVAILABLE', 'The backups folder could not be opened. Try again.'); },
  exclusive: async (action, ownMutation) => {
    assertWorkAllowed();
    restoringBackup = true;
    try {
      browserForms.cancelAll(); pendingApproval?.finish(false);
      await Promise.allSettled([...mutations].filter(pending => pending !== ownMutation));
      await vault.flush();
      assertStorageAvailable();
      return await action();
    } finally { restoringBackup = false; emit(); }
  },
  onRestored: () => {
    browserForms.cancelAll(); sessionEpoch++; careerViewRevision++;
    browserSessions.clear(); applicationSockets.clear();
    for (const waiting of browserReplies.values()) waiting.reject(waiting.failure('The profile was restored. Read this page again.'));
    browserReplies.clear(); mcpBridge?.disconnect();
  },
});
updates = createUpdateController({
  version: packageMetadata.version, platform: process.platform, arch: process.arch,
  directory: updateDirectory,
  sourceRoot: !localOnly && !app.isPackaged ? root : undefined,
  appPath: binaryInstallationTarget,
  packaged: app.isPackaged && !localOnly, pid: process.pid,
  acquireInstallAdmission, quit: () => app.quit(), onChange: () => emit(),
});
updateScheduler = createUpdateScheduler({
  updates, preferences: createUpdatePreferences(updateDirectory),
  install: installUpdate, canInstall: () => updateIdle(true),
  suspended: () => sleeping || quitDraining, onChange: () => emit(),
});
function updateState() {
  return { ...updates.state(), automation: updateScheduler.state(), blocked: !updateIdle(false) };
}
function updateIdle(automatic, { admitted = false } = {}) {
  if ((!admitted && updateInstalling) || quitDraining || sleeping || restoringBackup || pendingApproval || initializing || !vaultOpened || locked ||
      mutations.size || formRequests.size || browserReplies.size || workGate.state().active) return false;
  if (!automatic) return true;
  const automation = updateScheduler.state();
  if (!automation.enabled || automation.preferencePending) return false;
  if (window && !window.isDestroyed() && window.isFocused()) return false;
  if (!workGate.quiet()) return false;
  return computerIdle();
}
function computerIdle() {
  try {
    if (powerMonitor.getSystemIdleState?.(5 * 60) === 'unknown') return true;
    return powerMonitor.getSystemIdleTime() >= 5 * 60;
  } catch { return true; } // Not every desktop session provides an OS idle counter.
}
async function cancelUpdate() {
  if (['checking', 'downloading', 'staging'].includes(updates.state().status)) await updates.cancel();
  return updateState();
}
function installUpdate(options) {
  if (!updateInstallTask) updateInstallTask = performUpdateInstall(options).finally(() => { updateInstallTask = undefined; });
  return updateInstallTask;
}
async function acquireInstallAdmission({ automatic = false } = {}) {
  if (!updateIdle(automatic) || !workGate.close()) return null;
  let released = false;
  updateInstalling = true; emit();
  const valid = () => !released && workGate.state().closed && updateIdle(automatic, { admitted: true });
  const release = () => {
    if (released) return;
    released = true; updateInstalling = false;
    if (!quitDraining) workGate.reopen();
    emit();
  };
  try {
    await workGate.drain();
    await vault.flush();
    if (!valid()) { release(); return null; }
    return { valid, release };
  } catch (error) { release(); throw error; }
}
async function performUpdateInstall({ automatic = false } = {}) {
  if (!updateIdle(automatic)) {
    if (automatic) return false;
    fail('LOCAL_BUSY', 'Finish active work before restarting the companion.');
  }
  // Hashing, extracting and building must leave ordinary work available. The
  // engine requests final admission only after its helper is ready to commit.
  const result = await updates.install({ automatic });
  if (result?.manualPath && !automatic) {
    if (result.reveal) shell.showItemInFolder(result.manualPath);
    else {
      const error = await shell.openPath(result.manualPath);
      if (error) fail('UPDATE_MANUAL_OPEN_FAILED', 'The downloaded update could not be opened. Check the update status and try again.');
    }
  }
  return ['installing', 'launched'].includes(updates.state().status) || Boolean(result?.manualPath);
}
async function updateAction(op) {
  assertAvailable(false);
  if (op === 'update-cancel') return cancelUpdate();
  if (updateInstalling || quitDraining) fail('LOCAL_BUSY', 'The companion is restarting or closing.');
  if (op === 'update-check') await updateScheduler.checkNow();
  else if (op === 'update-download') await updates.download();
  else if (op === 'update-install') await installUpdate();
  else if (op === 'update-source-guide') await shell.openExternal('https://recruiters.rip/downloads#source-install');
  else fail('INVALID_INPUT', 'This update action is unavailable.');
  return updateState();
}
async function admitInstallationStartup() {
  if (!localOnly && !app.isPackaged) {
    try { managedSource = await inspectManagedSource(root, { version: packageMetadata.version }); }
    catch { managedSource = null; } // An invalid receipt never grants managed-install authority.
  }
  const target = binaryInstallationTarget || managedSource?.root;
  if (target) {
    try {
      releaseInstallation = await claimInstallation(target);
      if (!releaseInstallation) return false;
    } catch (error) {
      // Read-only installations can run, but cannot be automatically replaced;
      // their helpers also require this exclusion and a writable target parent.
      if (!['EACCES', 'EROFS'].includes(error.code)) throw error;
    }
  }
  if (quitDraining) return false;
  installationAdmitted = true;
  return true;
}
async function startUpdates() {
  if (!coreReady || locked || updatesStarted || quitDraining) return;
  updatesStarted = true;
  try { await updates.initialize(); } catch { /* The updater retains its actionable error; career access remains available. */ }
  void updateScheduler.start();
}
function assertStorageAvailable() {
  if (locked || screenLocked || sleeping) fail('LOCAL_LOCKED', 'Open the companion and unlock local storage.');
}
function assertAvailable() {
  assertStorageAvailable();
  if (restoringBackup) fail('LOCAL_BUSY', 'A profile is being restored. Wait for it to finish.');
}
function safeFailure(error) {
  const allowed = new Set(['DEVICE_OFFLINE', 'DEVICE_UNAUTHORIZED', 'DEVICE_REQUEST_FAILED', 'LOCAL_LOCKED', 'LOCAL_BUSY', 'IDENTITY_CHANGED', 'LEGACY_VAULT_LOCKED', 'NOT_FOUND', 'INVALID_INPUT', 'PAIRING_REQUIRED', 'CANCELLED', 'HOST_UNAVAILABLE', 'HOST_INSTALL_FAILED', 'UPDATE_MANUAL_OPEN_FAILED']);
  const known = error instanceof CareerError || error?.publicUpdateError === true || allowed.has(error?.code);
  return { code: known ? error.code : 'LOCAL_OPERATION_FAILED', message: known ? error.message : 'This action could not be completed. Reopen the companion and try again.' };
}
function status() {
  if (locked || screenLocked || sleeping) return { installed: true, mode: 'local_mcp', paired: false, hasCv: false, applicationWorkflowVersion: 2,
    companionVersion: packageMetadata.version, browserExtensions: { ...browserExtensions },
    decisionApiConfigured: false, connections: [], execution: { state: 'locked' } };
  const state = vault.get();
  return { installed: true, mode: 'local_mcp', deviceId: state.deviceId, publicKey: state.publicKey, label: state.label,
    applicationWorkflowVersion: 2, hostInfo: reviewHostInfo,
    companionVersion: packageMetadata.version, browserExtensions: { ...browserExtensions },
    preferredHost: ['claude', 'codex'].includes(state.browserPreferences?.applicationHost) ? state.browserPreferences.applicationHost : reviewHosts.codex ? 'codex' : 'claude',
    hasCv: Object.values(state.career?.sources ?? {}).some(source => source.purpose === 'cv' && !source.archived && typeof source.text === 'string' && source.text.trim().length > 0),
    paired: Boolean(state.pairing), decisionApiConfigured: decisionCredentialStatus(state).configured, connections: [], execution: { state: state.pairing ? 'ready' : 'needs_connection' } };
}
function setup() {
  const command = mcpCommand(directory);
  return { command, agentPrompt: agentSetupPrompt(command, { localOnly }),
    claudePackage: path.join(app.isPackaged ? root.replace(/app\.asar$/, 'app.asar.unpacked') : root, 'src', 'generated', localOnly ? 'recruiters-rip-local.mcpb' : 'recruiters-rip.mcpb') };
}
// Installed review hosts and their recruiters.rip entries are read at startup, when the window regains focus and after setup/review actions; opening Jobs does not stat the disk every refresh.
let reviewHosts = { claude: false, codex: false }, reviewHostInfo = {};
async function refreshReviewHosts() {
  try {
    const info = await applicationAccess().launcher.info();
    if (JSON.stringify(info) !== JSON.stringify(reviewHostInfo)) {
      reviewHostInfo = info;
      reviewHosts = Object.fromEntries(Object.entries(info).map(([key, value]) => [key, value.available]));
      emit();
    }
  } catch { /* keeps the last known value */ }
  await refreshAddedHosts();
}
// "Added" means the app's own config names recruiters.rip; also re-read whenever an app connects.
let hostsAdded = { codex: false, claude: false };
async function refreshAddedHosts() {
  try {
    const next = await addedHosts({ workspace: path.join(directory, 'host-integration', 'application-workspace'), localOnly });
    if (next.codex !== hostsAdded.codex || next.claude !== hostsAdded.claude) { hostsAdded = next; emit(); }
  } catch { /* keeps the last known value */ }
}
function localState() {
  const publicState = status();
  const browserIntegration = { registered: browserRegistrations, connected: [...new Set([...sockets].map(socket => socket.browser))] };
  if (locked) return { ...publicState, failure, browserConnection, browserIntegration, mcpClients };
  const state = vault.get();
  return { ...publicState, account: state.pairing?.account ?? null, reconnectAccount: state.reconnectAccount ?? null, origin: state.pairing?.origin ?? null, browserConnection, browserIntegration, mcpClients, failure,
    setup: setup(), careerViewVersion: `${state.deviceId}:${sessionEpoch}:${careerViewRevision}`,
    decisions: { credentials: decisionCredentialStatus(state) },
    publicationRange: savedPublicationRange(state.career ?? {}),
    updates: updateState(),
    review: { hosts: reviewHosts, hostInfo: reviewHostInfo, added: hostsAdded, preferredHost: ['claude', 'codex'].includes(state.browserPreferences?.applicationHost) ? state.browserPreferences.applicationHost : reviewHosts.codex ? 'codex' : 'claude' },
    introductions: introductionsStatus(state.career ?? {}),
    approval: pendingApproval ? { id: pendingApproval.id, title: pendingApproval.title, detail: pendingApproval.detail } : null };
}
function emit(event = 'status', payload = status()) {
  const bytes = encode({ version: 1, event, payload });
  for (const socket of sockets) if (!socket.destroyed) socket.write(bytes);
  if (window && !window.isDestroyed()) window.webContents.send('state-changed');
}
function showSettings() {
  if (!installationAdmitted) return;
  if (window && !window.isDestroyed()) { window.show(); window.focus(); window.webContents.send('state-changed'); return windowLoaded; }
  window = new BrowserWindow({ width: 1180, height: 820, minWidth: 420, minHeight: 560, title: 'Recruiters.rip Companion', backgroundColor: '#0a0b0e',
    webPreferences: { preload: path.join(root, 'src', 'preload.cjs'), partition: 'recruiters-settings', nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, devTools: !app.isPackaged, spellcheck: false } });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.on('will-attach-webview', event => event.preventDefault());
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  window.on('focus', () => { workGate.activity(); void refreshReviewHosts(); });
  window.on('blur', () => workGate.activity());
  window.webContents.on('before-input-event', () => workGate.activity());
  window.webContents.session.setPermissionCheckHandler(() => false);
  // The renderer reaches the network for exactly one thing: employer logos named by the catalogue (`<img>` only, https only,
  // no referrer, in-memory session so no cookies). Scripts, styles, fetches, frames and navigations stay local.
  window.webContents.session.webRequest.onBeforeRequest((details, callback) => callback({
    cancel: !(details.url.startsWith(pathToFileURL(root + path.sep).href) || (details.resourceType === 'image' && details.url.startsWith('https://'))),
  }));
  window.on('close', event => { if (!exiting) { event.preventDefault(); window.hide(); } });
  windowLoaded = window.loadURL(uiURL);
  // `pnpm dev` only: reload the settings window when its static UI files change.
  if (!app.isPackaged && process.env.RECRUITERS_COMPANION_DEV === '1') {
    let pending;
    const watcher = watch(path.join(root, 'ui'), { recursive: true }, () => {
      clearTimeout(pending);
      pending = setTimeout(() => { if (!window.isDestroyed()) window.webContents.reloadIgnoringCache(); }, 100);
    });
    window.on('closed', () => watcher.close());
  }
  return windowLoaded;
}
async function showDecisionsSettings() {
  await showSettings();
  window.webContents.send('settings-section', 'decisions');
}
function confirm(title, detail, signal) {
  const pending = confirmation.then(() => new Promise(resolve => {
    if (locked || quitDraining || signal?.aborted) { resolve(false); return; }
    let approval;
    const abort = () => approval.finish(false);
    const timer = setTimeout(() => approval.finish(false), 120000);
    approval = { id: randomUUID(), title, detail, finish(allow) {
      clearTimeout(timer); signal?.removeEventListener('abort', abort);
      if (pendingApproval !== approval) return;
      pendingApproval = undefined; emit(); resolve(allow === true && !locked && !signal?.aborted);
    } };
    pendingApproval = approval;
    signal?.addEventListener('abort', abort, { once: true });
    showSettings(); emit();
  }));
  confirmation = pending.catch(() => false); return pending;
}
async function initialize() {
  if (screenLocked || sleeping) fail('LOCAL_LOCKED', 'Unlock this computer before opening saved career data.');
  if (!locked) return;
  if (initializing) return initializing;
  initializing = (async () => {
    await vault.open();
    vaultOpened = true;
    await vault.update(state => { state.career = upgradeCareer(state.career); });
    if (screenLocked || sleeping) fail('LOCAL_LOCKED', 'Unlock this computer before opening saved career data.');
    locked = false; failure = ''; client = createDeviceClient(store, localOnly, { onUnpaired: forgetRevokedPairing });
    files = createDocumentFiles({ directory, store, assertAvailable });
  })();
  try { await initializing; } finally { initializing = undefined; }
}
function object(value) { if (!value || typeof value !== 'object' || Array.isArray(value)) fail('INVALID_INPUT', 'Use the supported operation fields.'); return value; }
function exact(value, keys) { object(value); if (Object.keys(value).some(key => !keys.includes(key))) fail('INVALID_INPUT', 'Unsupported operation fields.'); }
async function pair(payload) {
  return mutation(async () => {
  assertAvailable(false); exact(payload, ['productOrigin', 'pairing']);
  const pairing = object(payload.pairing); exact(pairing, ['deviceId', 'challenge', 'expiresAt', 'account']);
  const expiry = typeof pairing.expiresAt === 'number' ? pairing.expiresAt : Date.parse(pairing.expiresAt);
  if (payload.productOrigin !== productOrigin || pairing.deviceId !== store.get().deviceId || !Number.isFinite(expiry) || expiry <= Date.now() || expiry > Date.now() + 301000 || typeof pairing.challenge !== 'string' || pairing.challenge.length > 512 || !pairing.account || typeof pairing.account.id !== 'string' || pairing.account.id.length > 200 || typeof pairing.account.label !== 'string' || pairing.account.label.length > 240) fail('INVALID_INPUT', 'The account pairing link is invalid or expired. Start a new connection from local settings.');
  exact(pairing.account, ['id', 'label']);
  const existing = store.get().pairing, expected = existing?.account ?? store.get().reconnectAccount;
  if ((expected && expected.id !== pairing.account.id) || (existing && existing.origin !== payload.productOrigin)) fail('INVALID_INPUT', 'This computer is paired with another account. Sign in with the account shown in the companion.');
  if (!await confirm('Connect this platform account?', `Account: ${JSON.stringify(pairing.account.label)}\nAccount ID: ${pairing.account.id}\nPlatform: ${payload.productOrigin}\n\nAllow this computer to access the job feed.`)) fail('CANCELLED', 'Account connection canceled.');
  const activation = await client.request('POST', '/device/activate', { challenge: pairing.challenge, account: pairing.account }, { origin: payload.productOrigin });
  if (activation.deviceId !== pairing.deviceId || activation.account?.id !== pairing.account.id || activation.account?.label !== pairing.account.label) fail('INVALID_INPUT', 'The activated account does not match the local approval.');
  await store.update(state => { if (state.deviceId !== pairing.deviceId) fail('INVALID_INPUT', 'The device identity changed during pairing.'); state.pairing = { origin: payload.productOrigin, account: { ...pairing.account } }; delete state.reconnectAccount; });
  emit(); return status();
  });
}
async function forgetRevokedPairing() {
  await vault.forgetPairing(); emit();
}
async function connectAccount() {
  assertAvailable(false);
  if (store.get().reconnectAccount && !store.get().pairing) { browserForms?.cancelAll(); sessionEpoch++; mcpBridge?.disconnect(); await vault.rotateIdentity(); emit(); }
  const state = store.get();
  const url = new URL('/settings/provider', productOrigin);
  pairingReturn?.close(); pairingReturn = undefined;
  if (!state.pairing) {
    pairingReturn = await startPairingReturn({ onPair: async payload => {
      try { await pair(payload); }
      catch (error) { failure = safeFailure(error).message; emit(); throw error; }
    } });
    const { companionReturn, companionState } = pairingReturn;
    url.search = new URLSearchParams({ deviceId: state.deviceId, publicKey: state.publicKey, deviceLabel: state.label, companionReturn, companionState }).toString();
  }
  try { await shell.openExternal(url.href); }
  catch (error) { pairingReturn?.close(); pairingReturn = undefined; throw error; }
  failure = '';
  return { pairingRequired: !state.pairing };
}
function acceptPairingURL(raw) {
  if (localOnly || !app.isPackaged) return;
  try {
    if (typeof raw !== 'string' || raw.length > 8192) throw new Error();
    const url = new URL(raw);
    if (url.protocol !== 'recruiters-companion:' || url.hostname !== 'pair' || url.username || url.password || url.port || !['', '/'].includes(url.pathname) || [...url.searchParams.keys()].some(key => key !== 'payload')) throw new Error();
    const value = url.searchParams.get('payload'); if (!value || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error();
    const payload = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (!app.isReady() || locked) { queuedPairing = payload; if (app.isReady()) showSettings(); return; }
    void pair(payload).catch(error => { failure = safeFailure(error).message; showSettings(); emit(); });
  } catch { failure = 'The account link is invalid. Start a new connection from local settings.'; if (app.isReady()) showSettings(); }
}
async function platform(operation, args) {
  assertAvailable(false);
  if (!store.get().pairing) fail('PAIRING_REQUIRED', 'Connect your account in companion settings.');
  return client.request('POST', '/device/platform', { operation, args });
}
async function selectSourceFile() {
  assertAvailable(true); showSettings();
  const result = await dialog.showOpenDialog(window, { title: 'Choose your source CV', properties: ['openFile'], filters: [{ name: 'CV documents', extensions: ['pdf', 'docx', 'txt'] }] });
  assertAvailable(true);
  return result.canceled || !result.filePaths[0] ? null : readSelectedSource(result.filePaths[0]);
}
async function openInBrowser(value) {
  assertWorkAllowed();
  let url;
  try { url = new URL(value); } catch { fail('INVALID_INPUT', 'Open a saved HTTP(S) job page.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.href.length > 4096)
    fail('INVALID_INPUT', 'Open a saved HTTP(S) job page without embedded credentials.');
  try { await shell.openExternal(url.href); }
  catch { throw new CareerError('BROWSER_UNAVAILABLE', 'Set a default web browser in system settings, then open this application again.'); }
  return { opened: true };
}
function applicationAccess() {
  const scoped = createScopedAccess(store, { assertAvailable, epoch: () => sessionEpoch });
  const localFiles = createDocumentFiles({ directory, store: scoped.store, assertAvailable: scoped.assertAvailable });
  const workflow = createApplicationWorkflow({
    store: scoped.store, assertAvailable: scoped.assertAvailable,
    validateExport: async record => {
      try { await localFiles.resolveExport(record.uri); return true; } catch { return false; }
    },
  });
  const launcher = createApplicationLauncher({ directory: path.join(directory, 'host-integration'), command: setup().command,
    protocolAvailable: process.platform === 'linux' ? undefined : async scheme => {
      try { return Boolean((await app.getApplicationInfoForProtocol(`${scheme}://`)).path); } catch { return false; }
    },
    openExternal: async url => { scoped.assertAvailable(false); await shell.openExternal(url); scoped.assertAvailable(false); } });
  const view = async result => {
    const hostInfo = await launcher.info(); scoped.assertAvailable(false);
    const hosts = Object.fromEntries(Object.entries(hostInfo).map(([key, value]) => [key, value.available]));
    const saved = scoped.store.get().browserPreferences?.applicationHost;
    return { ...result, hosts, hostInfo, preferredHost: ['claude', 'codex'].includes(saved) ? saved : hosts.codex ? 'codex' : 'claude' };
  };
  return { ...scoped, localFiles, workflow, launcher, view };
}
function createSessionServer() {
  const scoped = createScopedAccess(store, { assertAvailable, epoch: () => sessionEpoch });
  const localFiles = createDocumentFiles({ directory, store: scoped.store, assertAvailable: scoped.assertAvailable });
  const scopedPlatform = async (operation, args) => {
    scoped.assertAvailable(false); const result = await platform(operation, args); scoped.assertAvailable(false); return result;
  };
  const applicationFlow = createApplicationWorkflow({ store: scoped.store, assertAvailable: scoped.assertAvailable,
    validateExport: async record => { try { await localFiles.resolveExport(record.uri); return true; } catch { return false; } } });
  let server;
  const interaction = {
    canElicit: () => Boolean(server?.getClientCapabilities()?.elicitation?.form),
    async elicit(params) {
      scoped.assertAvailable(false);
      const result = await server.elicitInput(params);
      scoped.assertAvailable(false);
      return result;
    },
  };
  const tools = [
    ...createPlatformTools({ store: scoped.store, platform: scopedPlatform, connectAccount, openSettings: showSettings }),
    ...createProfileTools({ store: scoped.store, interaction, selectSourceFile: async () => {
      scoped.assertAvailable(true); const result = await selectSourceFile(); scoped.assertAvailable(true); return result;
    }, extractFile: documents.extractFile }),
    ...createApplicationTools({ store: scoped.store, platform: scopedPlatform, documents, exportDocument: localFiles.exportDocument, cleanupExports: localFiles.cleanupExports, withExportTransaction: localFiles.withExportTransaction }),
    ...createApplicationPreparationTools({ workflow: applicationFlow, openInBrowser: async url => {
      scoped.assertAvailable(false); const result = await openInBrowser(url); scoped.assertAvailable(false); return result;
    } }),
    ...createMatchingTools({ store: scoped.store, platform: scopedPlatform, exportDocument: localFiles.exportDocument }),
    ...createJobTools({ store: scoped.store }),
    ...createFormTools({ store: scoped.store, browser: browserBridge }),
    ...createIntroductionTools({ store: scoped.store, platform: scopedPlatform,
      getAccountId: () => scoped.store.get().pairing?.account?.id,
      shareCv: async body => {
        scoped.assertAvailable(false);
        if (!store.get().pairing) fail('PAIRING_REQUIRED', 'Connect your account in companion settings.');
        const result = await client.request('POST', '/device/cv', body);
        scoped.assertAvailable(false);
        return result;
      },
      openGithub: async () => { scoped.assertAvailable(false); await shell.openExternal(new URL('/account#github', productOrigin).href); } }),
  ];
  for (const tool of tools) {
    const invoke = tool.invoke;
    tool.invoke = (input, context) => tool.readOnly
      ? workGate.run(() => invoke(input, context))
      : mutation(() => invoke(input, context));
  }
  server = createMcpServer({ tools, assertAvailable: scoped.assertAvailable,
    readResource: uri => workGate.run(() => localFiles.readResource(uri)),
    listResources: () => workGate.run(() => localFiles.listResources()),
    notifyActivity: name => {
      if (tools.some(tool => tool.name === name && !tool.readOnly)) { careerViewRevision++; emit(); }
    } });
  return server;
}
async function installConnections() {
  await privateDirectory(directory);
  const profileDirectory = await realpath(directory), userData = await realpath(path.dirname(profileDirectory));
  const runtime = await prepareBridgeRuntime({ executable: process.execPath, appPath: app.getAppPath(), directory, packaged: app.isPackaged, version: packageMetadata.version });
  const launch = { executable: runtime.executable, directory: profileDirectory, userData,
    args: [...(app.isPackaged ? [] : [runtime.appPath]), `--user-data-dir=${userData}`, ...(localOnly ? ['--local-product'] : [])], localOnly };
  await writeFile(path.join(directory, 'mcp-launch.json'), JSON.stringify(launch), { mode: 0o600 });
  protectPrivatePath(path.join(directory, 'mcp-launch.json'));
  const script = path.join(runtime.runtimeRoot, 'src', 'generated', 'mcp-host.cjs');
  await writeFile(setup().command, launcherScript({ executable: runtime.executable, script,
    args: [`--directory=${profileDirectory}`, ...(localOnly ? ['--local-product'] : [])] }), { mode: 0o700 });
  protectPrivatePath(setup().command, { mode: 0o700 });
  try { await unlink(path.join(directory, 'recruiters-mcp')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (app.isPackaged && !localOnly) app.setAsDefaultProtocolClient('recruiters-companion');
  try {
    const result = await installNative({ executable: runtime.executable, appPath: runtime.appPath, directory, packaged: app.isPackaged, localOnly });
    browserRegistrations = result.browsers; browserConnection = result.installed ? 'installed' : 'unavailable';
  } catch { browserConnection = 'unavailable'; }
  await Promise.all(['chrome', 'firefox'].map(async browser => {
    try { await refreshBrowserExtension(browser); }
    catch { delete browserExtensions[browser]; }
  }));
}
// Save to Downloads creates the managed folder; launches refresh only folders the user saved,
// so Companion never touches Downloads (or triggers OS folder prompts) uninvited.
async function refreshBrowserExtension(browser, save = false) {
  const firefox = browser === 'firefox';
  const source = path.join(app.isPackaged ? root.replace(/app\.asar$/, 'app.asar.unpacked') : root,
    'browser-extension', 'dist', `${firefox ? 'firefox-' : ''}${localOnly ? 'local' : 'production'}`);
  let manifest;
  try { manifest = JSON.parse(await readFile(path.join(source, 'manifest.json'), 'utf8')); }
  catch { fail('HOST_INSTALL_FAILED', app.isPackaged ? 'The bundled browser extension is missing. Reinstall the complete companion.' : 'Build the companion before saving its browser extension.'); }
  if (manifest.version !== packageMetadata.version || (firefox ? manifest.browser_specific_settings?.gecko?.id !== browserIdentity.firefoxExtensionId : manifest.key !== browserIdentity.key))
    fail('HOST_INSTALL_FAILED', 'The bundled browser extension does not match this companion. Rebuild or reinstall the complete companion.');
  const record = path.join(directory, 'browser-extension-folders.json');
  let folders = {};
  try { folders = privateJSON(record); } catch { /* Nothing saved yet. */ }
  const destination = save ? path.join(app.getPath('downloads'), `Recruiters.rip ${firefox ? 'Firefox' : 'Chrome'} extension${localOnly ? ' (local)' : ''}`) : folders[browser];
  if (typeof destination !== 'string') return null;
  let folder;
  try { folder = await persistBrowserExtension({ source, destination, create: save }); }
  catch (error) { fail('HOST_INSTALL_FAILED', error.code === 'HOST_INSTALL_FAILED' ? error.message : 'Companion could not save the extension to Downloads. Allow Companion to use your Downloads folder, then try again.'); }
  if (!folder) return null;
  browserExtensions[browser] = { managed: true, version: manifest.version };
  if (save && folders[browser] !== folder) {
    await writeFile(record, JSON.stringify({ ...folders, [browser]: folder }), { mode: 0o600 });
    protectPrivatePath(record);
  }
  return folder;
}
async function nativeOperation(op, payload, socket = null) {
  const keys = { status: [], open_settings: [], open_decisions_settings: [], pair: ['productOrigin', 'pairing'],
    capture_jobs: ['requestId', 'sourceUrl', 'jobs'], forms_prepare: ['requestId', 'formId', 'url', 'title', 'fields', 'actions', 'useApi'], forms_cancel: ['requestId'],
    forms_validate: ['formId', 'fields'], forms_answer_save: ['requestId', 'formId', 'snapshot', 'fieldId', 'value', 'source'],
    application_resolve: ['requestId', 'page', 'jobs', 'context'], application_status: ['bindingId'], application_host: ['host'],
    application_prepare: ['bindingId', 'host'], application_document: ['bindingId', 'kind', 'action'], application_open_ad: ['bindingId'], application_copy_intro: ['bindingId'] };
  if (!Object.hasOwn(keys, op)) fail('INVALID_INPUT', 'This browser operation is unavailable.');
  exact(payload, keys[op]);
  if (op === 'status') return status();
  if (op === 'open_settings') { showSettings(); return { opened: true }; }
  if (op === 'open_decisions_settings') { await showDecisionsSettings(); return { opened: true }; }
  if (op === 'pair') return pair(payload);
  assertAvailable(false);
  if (op === 'application_host') return mutation(async () => {
    const result = await applicationAccess().workflow.setHost(payload);
    emit(); return result;
  });
  if (op.startsWith('application_')) {
    const access = applicationAccess();
    if (op === 'application_resolve') return mutation(async () => {
      const result = await access.workflow.resolve(payload);
      access.assertAvailable(false);
      applicationSockets.set(result.bindingId, { socket, epoch: sessionEpoch, identity: identityKey(store.get()) });
      careerViewRevision++; emit();
      return access.view(result);
    });
    const bound = applicationSockets.get(payload.bindingId);
    if (!bound || !socket || socket.destroyed || !socket.writable || bound.socket !== socket || bound.epoch !== sessionEpoch || bound.identity !== identityKey(store.get()))
      fail('FORM_CONTEXT_CHANGED', 'Read this application page again before using its documents.');
    if (op === 'application_status') return access.view(await access.workflow.status(payload));
    if (op === 'application_copy_intro') {
      assertWorkAllowed();
      return access.workflow.copyIntroduction(payload, text => clipboard.writeText(text));
    }
    if (op === 'application_prepare') return mutation(async () => {
      const { preparationId } = await access.workflow.prepare(payload);
      access.assertAvailable(false);
      const opened = await access.launcher.open({ host: payload.host, preparationId });
      access.assertAvailable(false);
      await access.workflow.launched({ preparationId, host: payload.host, mode: opened.mode });
      await access.workflow.setHost({ host: payload.host });
      careerViewRevision++; emit();
      return { ...await access.view(await access.workflow.status({ bindingId: payload.bindingId })), ...opened, preparationId };
    });
    if (op === 'application_open_ad') {
      const url = await access.workflow.jobUrl(payload);
      access.assertAvailable(false); return openInBrowser(url);
    }
    if (!['cv', 'cover_letter'].includes(payload.kind) || !['open', 'reveal'].includes(payload.action))
      fail('INVALID_INPUT', 'Choose a current CV or cover-letter PDF to open or show in your file manager.');
    const record = await access.workflow.document({ bindingId: payload.bindingId, kind: payload.kind });
    const filename = await access.localFiles.resolveExport(record.uri);
    const current = await access.workflow.document({ bindingId: payload.bindingId, kind: payload.kind });
    access.assertAvailable(false);
    if (current.uri !== record.uri) fail('FORM_CONTEXT_CHANGED', 'The application document changed. Open its current version.');
    if (payload.action === 'reveal') shell.showItemInFolder(filename);
    else {
      const error = await shell.openPath(filename);
      if (error) fail('EXPORT_UNAVAILABLE', 'The PDF could not be opened. Show it in your file manager instead.');
    }
    return { opened: true, kind: payload.kind, action: payload.action };
  }
  if (op === 'forms_answer_save') {
    const session = browserSessions.get(payload.formId);
    if (!session || session.socket !== socket || session.epoch !== sessionEpoch || session.identity !== identityKey(store.get()))
      fail('FORM_CONTEXT_CHANGED', 'Read this application page before saving answers.');
    const before = session.evidence, result = await browserForms.saveAnswer(payload);
    // The save re-binds current drafts to the new evidence; keep prepared clipboard sessions bound to them too.
    const drafts = store.get().career?.formDrafts ?? {};
    for (const [formId, other] of browserSessions) if (other.evidence === before && drafts[formId]) other.evidence = drafts[formId].evidence;
    if (drafts[payload.formId]) session.answersHash = hash(drafts[payload.formId].answers ?? {});
    careerViewRevision++; emit(); return result;
  }
  if (op === 'forms_validate') {
    if (typeof payload.formId !== 'string' || payload.formId.length > 100 || !Array.isArray(payload.fields) || payload.fields.length > 64)
      fail('INVALID_INPUT', 'Provide the prepared form and its inspected field signatures.');
    const session = browserSession(payload.formId);
    if (session.socket !== socket) fail('FORM_CONTEXT_CHANGED', 'This browser connection did not prepare the form.');
    const draft = currentForm(store.get().career ?? createCareerState(), payload.formId);
    if (session.answersHash !== hash(draft.answers ?? {}) || payload.fields.length !== draft.fields.length)
      fail('FORM_CONTEXT_CHANGED', 'Prepared answers changed. Choose Read page before pasting.');
    for (let index = 0; index < payload.fields.length; index++) {
      const field = payload.fields[index]; exact(field, ['id', 'signature']);
      if (field.id !== draft.fields[index].id || field.signature !== draft.fields[index].signature)
        fail('FORM_CONTEXT_CHANGED', 'The inspected form changed. Choose Read page before pasting.');
    }
    return { valid: true };
  }
  if (op === 'forms_cancel') {
    if (typeof payload.requestId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(payload.requestId)) fail('INVALID_INPUT', 'Use the preparation request UUID.');
    return browserForms.cancel(payload.requestId);
  }
  if (op === 'capture_jobs') return mutation(async () => {
    const scoped = createScopedAccess(store, { assertAvailable, epoch: () => sessionEpoch });
    const result = await saveAppliedJobs({ store: scoped.store, ...payload, revision: scoped.store.get().career?.revision ?? 0 });
    scoped.assertAvailable(false); careerViewRevision++; emit(); return result;
  });
  if (payload.useApi !== undefined && typeof payload.useApi !== 'boolean') fail('INVALID_INPUT', 'Choose whether to use the optional Decisions API.');
  return mutation(async () => {
    const useApi = decisionCredentials.publicState().configured && payload.useApi !== false;
    const scoped = createScopedAccess(store, { assertAvailable, epoch: () => sessionEpoch });
    const preparedState = scoped.store.get(), identity = identityKey(preparedState);
    const evidence = formEvidence(preparedState.career ?? createCareerState()), credentialVersion = preparedState.prescanCredentialVersion ?? 0;
    if (formRequests.has(payload.requestId)) fail('REQUEST_CONFLICT', 'This form preparation is already pending.');
    formRequests.set(payload.requestId, useApi); emit();
    try {
      const result = await browserForms.prepare({ ...payload, useApi });
      const current = scoped.store.get(), draft = currentForm(current.career ?? createCareerState(), result.formId);
      const previous = preparedState.career?.formDrafts?.[result.formId];
      const answersHash = hash(previous?.evidence === evidence && previous.evidenceRevision === (preparedState.career?.evidenceRevision ?? 0) ? previous.answers ?? {} : {});
      if (draft.evidence !== evidence || (current.prescanCredentialVersion ?? 0) !== credentialVersion || hash(draft.answers ?? {}) !== answersHash)
        fail('FORM_CONTEXT_CHANGED', 'Preparation context changed. Prepare the form again before using its values.');
      if (socket && !socket.destroyed) browserSessions.set(result.formId, { socket, epoch: sessionEpoch, identity, evidence, credentialVersion, answersHash });
      careerViewRevision++; emit(); return result;
    }
    finally { formRequests.delete(payload.requestId); emit(); }
  });
}
// The extension that prepared a form keeps its socket for read-only attachment checks.
const browserSessions = new Map(), browserReplies = new Map(), applicationSockets = new Map();
function browserSession(formId, expected) {
  assertWorkAllowed();
  const session = browserSessions.get(formId);
  if (!session || session.socket.destroyed || !session.socket.writable)
    fail('UNAVAILABLE', 'The browser is not attached to this form. Open the Recruiters.rip panel on the application tab and prepare values before a new action.');
  const state = store.get();
  if (session.epoch !== sessionEpoch || session.identity !== identityKey(state) || (expected && session !== expected))
    fail('FORM_CONTEXT_CHANGED', 'The browser preparation or local session changed. Prepare the form again before acting.');
  const draft = currentForm(state.career ?? createCareerState(), formId);
  if (session.evidence !== draft.evidence || session.credentialVersion !== (state.prescanCredentialVersion ?? 0))
    fail('FORM_CONTEXT_CHANGED', 'Career evidence or the API credential changed. Choose Read page before acting.');
  return session;
}
function browserStatus(session, formId) {
  browserSession(formId, session);
  const { socket } = session, id = randomUUID(), bytes = encode({ version: 1, id, op: 'forms_status', payload: { formId } });
  return new Promise((resolve, reject) => {
    const finish = (callback, value) => {
      if (browserReplies.get(id) !== waiting) return;
      browserReplies.delete(id); clearTimeout(waiting.timer); callback(value);
    };
    const waiting = { socket, resolve: value => finish(resolve, value), reject: error => finish(reject, error), timer: null,
      failure: detail => new CareerError('UNAVAILABLE', detail) };
    waiting.timer = setTimeout(() => waiting.reject(waiting.failure('The browser did not confirm the attachment in time.')), 5000);
    browserReplies.set(id, waiting);
    try { socket.write(bytes, error => { if (error) waiting.reject(waiting.failure('The browser connection failed before confirmation.')); }); }
    catch { waiting.reject(waiting.failure('The command could not be confirmed by the browser.')); }
  });
}
const browserBridge = {
  async status(formId) {
    const session = browserSession(formId);
    const result = await browserStatus(session, formId);
    browserSession(formId, session);
    return result?.attached === true;
  },
};
function encode(value) { const data = Buffer.from(JSON.stringify(value)); if (data.length > 1024 * 1024 - 1024) throw new Error('Native response too large.'); const header = Buffer.allocUnsafe(4); header.writeUInt32LE(data.length); return Buffer.concat([header, data]); }
async function startNativeBridge() {
  const token = randomBytes(32).toString('hex'), socketPath = endpoint(directory, 'native');
  if (process.platform !== 'win32') await privateDirectory(path.dirname(socketPath));
  if (process.platform !== 'win32') try { await unlink(socketPath); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  nativeBridge = net.createServer(socket => {
    let authenticated = false, input = Buffer.alloc(0), pending = 0, challenge;
    const timer = setTimeout(() => { if (!authenticated) socket.destroy(); }, 5000);
    socket.on('error', () => socket.destroy());
    socket.on('close', () => {
      clearTimeout(timer); sockets.delete(socket);
      for (const [formId, session] of browserSessions) if (session.socket === socket) browserSessions.delete(formId);
      for (const [bindingId, session] of applicationSockets) if (session.socket === socket) applicationSockets.delete(bindingId);
      for (const waiting of browserReplies.values()) if (waiting.socket === socket)
        waiting.reject(waiting.failure('The browser disconnected before confirming the operation.'));
      emit();
    });
    socket.on('data', chunk => {
      input = Buffer.concat([input, chunk]); if (input.length > 2 * 1024 * 1024) { socket.destroy(); return; }
      while (input.length >= 4) {
        const length = input.readUInt32LE(0); if (!length || length > 1024 * 1024 + 65536) { socket.destroy(); return; } if (input.length < length + 4) return;
        let message; try { message = JSON.parse(input.subarray(4, length + 4).toString('utf8')); } catch { socket.destroy(); return; } input = input.subarray(length + 4);
        if (!message || typeof message !== 'object' || Array.isArray(message)) { socket.destroy(); return; }
        if (!authenticated) {
          if (!challenge) {
            try { challenge = createAuthenticationChallenge(token, 'native', message); socket.write(encode(challenge.message)); }
            catch { socket.destroy(); return; }
            continue;
          }
          const browser = nativeBrowser(browserIdentity, message.origin);
          if (!browser || Object.keys(message).some(key => !['authProof', 'origin'].includes(key)) || !verifyAuthenticationProof(token, 'client', 'native', challenge, message.authProof)) { socket.destroy(); return; }
          authenticated = true; socket.browser = browser; clearTimeout(timer); sockets.add(socket); emit(); continue;
        }
        if (authenticated && message && typeof message === 'object' && Object.hasOwn(message, 'ok')) {
          const waiting = typeof message.id === 'string' ? browserReplies.get(message.id) : undefined;
          if (!waiting || waiting.socket !== socket || message.version !== 1 || typeof message.ok !== 'boolean') continue;
          if (message.ok === true && message.result && typeof message.result === 'object' && !Array.isArray(message.result)) waiting.resolve(message.result);
          else if (message.ok === true) waiting.reject(waiting.failure('The browser returned no usable result for this operation.'));
          else waiting.reject(waiting.failure(typeof message.error?.message === 'string' ? message.error.message.slice(0, 400) : 'The browser could not confirm this operation.'));
          continue;
        }
        if (Object.keys(message).some(key => !['version', 'id', 'op', 'payload'].includes(key)) || message.version !== 1 || typeof message.id !== 'string' || message.id.length > 100 || typeof message.op !== 'string' || ++pending > 8) { socket.destroy(); return; }
        const execute = () => nativeOperation(message.op, message.payload, socket);
        const operation = message.op === 'status' ? execute()
          : workGate.run(execute, { meaningful: message.op !== 'application_status' });
        void operation.then(result => ({ version: 1, id: message.id, ok: true, result }), error => ({ version: 1, id: message.id, ok: false, error: safeFailure(error) }))
          .then(reply => { if (!socket.destroyed) socket.write(encode(reply)); }).finally(() => { pending--; }).catch(() => socket.destroy());
      }
    });
  });
  await new Promise((resolve, reject) => { nativeBridge.once('error', reject); nativeBridge.listen(socketPath, resolve); });
  if (process.platform !== 'win32') await chmod(socketPath, 0o600);
  await writeFile(path.join(directory, 'bridge.json'), JSON.stringify({ socket: socketPath, token }), { mode: 0o600 });
  protectPrivatePath(path.join(directory, 'bridge.json'));
}
async function settingsOperation(op, input, ownMutation) {
  try {
    if (op === 'state') return { ok: true, result: localState() };
    if (['backup', 'backup-preview', 'backup-restore', 'backup-cancel', 'backup-open-folder'].includes(op)) {
      assertWorkAllowed();
      exact(input, op === 'backup-restore' ? ['restoreId', 'profileId'] : []);
      if (op === 'backup-restore' && (typeof input.restoreId !== 'string' || typeof input.profileId !== 'string')) fail('INVALID_INPUT', 'Choose a backup and a profile before restoring.');
      const result = op === 'backup' ? await backups.save()
        : op === 'backup-preview' ? await backups.preview()
        : op === 'backup-restore' ? await backups.restore(input, ownMutation)
        : op === 'backup-cancel' ? backups.cancel() : await backups.openFolder();
      emit(); return { ok: true, result };
    }
    if (op === 'cv-delete') {
      assertWorkAllowed(); exact(input, ['sourceId', 'contentHash']);
      if (typeof input.sourceId !== 'string' || input.sourceId.length > 100 || typeof input.contentHash !== 'string' || !/^[a-f0-9]{64}$/.test(input.contentHash)) fail('INVALID_INPUT', 'Choose the saved CV again before deleting it.');
      const scoped = createScopedAccess(store, { assertAvailable, epoch: () => sessionEpoch });
      const source = scoped.store.get().career?.sources?.[input.sourceId];
      if (!source || source.purpose !== 'cv' || source.contentHash !== input.contentHash) fail('CV_CHANGED', 'This CV changed. Choose it again before deleting it.');
      const choice = await dialog.showMessageBox(window, { type: 'warning', buttons: ['Cancel', 'Delete CV'], defaultId: 0, cancelId: 0,
        message: 'Delete this CV?', detail: 'Delete this CV from Companion and remove its shared copy from JobStash? Existing backup files are not deleted.' });
      scoped.assertAvailable(false);
      if (choice.response !== 1) return { ok: true, result: { cancelled: true } };
      const result = await deleteCv({ store: scoped.store, ...input,
        getAccountId: () => scoped.store.get().pairing?.account?.id,
        deleteRemote: async body => {
          scoped.assertAvailable(false);
          if (!scoped.store.get().pairing) fail('PAIRING_REQUIRED', 'Connect your account before removing the shared CV.');
          const result = await client.request('POST', '/device/cv/delete', body);
          scoped.assertAvailable(false);
          return result;
        },
      });
      scoped.assertAvailable(false); careerViewRevision++; browserForms.cancelAll(); emit();
      return { ok: true, result };
    }
    if (['career-list', 'career-read', 'career-open-document'].includes(op)) {
      const scoped = createScopedAccess(store, { assertAvailable, epoch: () => sessionEpoch });
      const localFiles = createDocumentFiles({ directory, store: scoped.store, assertAvailable: scoped.assertAvailable });
      const reader = createCareerBrowser({ store: scoped.store, files: localFiles,
        openPath: filename => { scoped.assertAvailable(false); return shell.openPath(filename); } });
      const result = await (op === 'career-list' ? reader.list(input) : op === 'career-read' ? reader.read(input) : reader.openDocument(input));
      scoped.assertAvailable(false);
      return { ok: true, result };
    }
    if (op === 'update-preferences') {
      assertAvailable(false);
      await updateScheduler.setPreferences(input);
      return { ok: true, result: updateState() };
    }
    if (op.startsWith('update-')) { exact(input, []); return { ok: true, result: await updateAction(op) }; }
    if (op === 'job-block' || op === 'job-unblock') {
      assertAvailable(false);
      exact(input, op === 'job-block' ? ['id', 'kind'] : ['id']);
      const scoped = createScopedAccess(store, { assertAvailable, epoch: () => sessionEpoch });
      let result;
      await scoped.store.update(state => {
        const career = state.career ??= createCareerState();
        if (op === 'job-block') { const entry = addBlock(career, input); result = { id: entry.id, kind: entry.kind, label: entry.label }; }
        else { removeBlock(career, input.id); result = { completed: true }; }
      });
      scoped.assertAvailable(false); careerViewRevision++;
      emit(); return { ok: true, result };
    }
    if (op === 'career-open-profile') {
      assertAvailable(false); exact(input, ['id']);
      const scoped = createScopedAccess(store, { assertAvailable, epoch: () => sessionEpoch });
      const result = await openEmploymentProfile({ store: scoped.store, platform, openExternal: url => shell.openExternal(url) }, input);
      scoped.assertAvailable(false);
      return { ok: true, result };
    }
    if (op === 'career-open-job') {
      assertAvailable(false); exact(input, ['kind', 'id']);
      const scoped = createScopedAccess(store, { assertAvailable, epoch: () => sessionEpoch });
      const result = await openJobPage({ store: scoped.store, openExternal: url => { scoped.assertAvailable(false); return shell.openExternal(url); } }, input);
      scoped.assertAvailable(false);
      return { ok: true, result };
    }
    if (op === 'copy-requirement-prompt') {
      assertAvailable(false); exact(input, ['id', 'requirement']);
      const scoped = createScopedAccess(store, { assertAvailable, epoch: () => sessionEpoch });
      const prompt = requirementContextPrompt({ store: scoped.store }, input);
      scoped.assertAvailable(false);
      clipboard.writeText(prompt);
      return { ok: true, result: { copied: true } };
    }
    if (op === 'sharing-allow' || op === 'sharing-stop') {
      assertAvailable(false); exact(input, []);
      const scoped = createScopedAccess(store, { assertAvailable, epoch: () => sessionEpoch });
      // Withdrawing stops future uploads only; anything already on JobStash stays there.
      await scoped.store.update(state => { setSharingConsent(state.career ??= createCareerState(), op === 'sharing-allow'); });
      scoped.assertAvailable(false);
      emit(); return { ok: true, result: { completed: true } };
    }
    // GitHub linking happens on the website through Privy; middleware's copy of the link is what the platform status reports.
    if (op === 'account-platform') {
      assertAvailable(false); exact(input, []);
      if (!store.get().pairing) return { ok: true, result: { paired: false } };
      try { const status = await platform('status', {}); return { ok: true, result: { paired: true, github: status?.github ?? null, membership: status?.membership ?? null } }; }
      catch (error) { return { ok: true, result: { paired: true, unavailable: error?.code === 'DEVICE_UNAUTHORIZED' ? 'reconnect' : 'offline' } }; }
    }
    if (op === 'connect-github') {
      assertAvailable(false); exact(input, []);
      if (!store.get().pairing) fail('PAIRING_REQUIRED', 'Connect your account first.');
      await shell.openExternal(new URL('/account#github', productOrigin).href);
      return { ok: true, result: { opened: true } };
    }
    if (op === 'decisions-key-save' || op === 'decisions-key-remove') {
      assertAvailable(false);
      const result = op === 'decisions-key-save' ? await decisionCredentials.save(input) : await decisionCredentials.remove(input);
      emit(); return { ok: true, result };
    }
    if (op === 'publication-range-set') {
      assertAvailable(false); exact(input, ['publicationRange']);
      const scoped = createScopedAccess(store, { assertAvailable, epoch: () => sessionEpoch });
      await scoped.store.update(state => { setPublicationRange(state.career ??= createCareerState(), input.publicationRange); });
      scoped.assertAvailable(false); careerViewRevision++;
      emit(); return { ok: true, result: { publicationRange: input.publicationRange } };
    }
    exact(input, op === 'approval' ? ['id', 'allow'] : []);
    if (op === 'unlock') { await initialize(); await startUpdates(); if (queuedPairing) { const payload = queuedPairing; queuedPairing = undefined; void pair(payload).catch(error => { failure = safeFailure(error).message; emit(); }); } emit(); return { ok: true, result: localState() }; }
    assertAvailable(false); let result = { completed: true };
    if (op === 'approval') { if (!pendingApproval || pendingApproval.id !== input.id || typeof input.allow !== 'boolean') fail('INVALID_INPUT', 'This approval expired.'); pendingApproval.finish(input.allow); }
    else if (op === 'delete-rankings') { result = await deleteRankings(store); careerViewRevision++; }
    else if (op === 'connect-account') result = await connectAccount();
    else if (op === 'import-cv') {
      const scoped = createScopedAccess(store, { assertAvailable, epoch: () => sessionEpoch });
      scoped.assertAvailable(true);
      const tools = createProfileTools({
        store: scoped.store,
        selectSourceFile: async () => {
          scoped.assertAvailable(true);
          const selected = await selectSourceFile();
          scoped.assertAvailable(true);
          return selected;
        },
        extractFile: documents.extractFile,
      });
      result = await tools.find(tool => tool.name === 'career_source_import').invoke({
        requestId: randomUUID(), revision: scoped.store.get().career?.revision ?? 0,
        method: 'file', purpose: 'cv',
      });
      scoped.assertAvailable(false);
      careerViewRevision++;
      result = { cancelled: Boolean(result.cancelled) };
    }
    else if (op === 'copy-review-prompt') clipboard.writeText(REVIEW_PROMPT);
    else if (op === 'review-codex' || op === 'review-claude') {
      const host = op === 'review-codex' ? 'codex' : 'claude';
      const access = applicationAccess();
      result = await access.launcher.review({ host });
      access.assertAvailable(false);
      await access.workflow.setHost({ host });
      await refreshReviewHosts();
    }
    else if (op === 'copy-agent-prompt') clipboard.writeText(setup().agentPrompt);
    else if (op === 'get-codex' || op === 'get-claude') {
      const codex = op === 'get-codex', cli = process.platform === 'linux';
      const url = codex
        ? cli ? 'https://developers.openai.com/codex/cli' : 'https://chatgpt.com/download/'
        : cli ? 'https://code.claude.com/docs/en/quickstart' : 'https://claude.ai/download';
      await shell.openExternal(url);
      result = { opened: true, destination: codex
        ? cli ? 'OpenAI’s Codex setup page' : 'OpenAI’s desktop download page'
        : cli ? 'Anthropic’s Claude Code setup page' : 'Anthropic’s Claude download page' };
    }
    else if (op === 'install-chatgpt') {
      result = await installChatGptPlugin({ directory, root: app.isPackaged ? root.replace(/app\.asar$/, 'app.asar.unpacked') : root, localOnly, command: setup().command });
      await refreshAddedHosts();
    }
    else if (op === 'install-claude') {
      const launcher = applicationAccess().launcher, hostInfo = await launcher.info();
      if (!hostInfo.claude.available) fail('HOST_UNAVAILABLE', hostInfo.claude.reason);
      if (hostInfo.claude.mode === 'cli') result = await launcher.connect('claude');
      else {
        const filename = await prepareClaudePackage({ template: setup().claudePackage, directory, localOnly, version: packageMetadata.version });
        const error = await shell.openPath(filename);
        if (error) fail('INVALID_INPUT', 'The Claude extension could not be opened. Use Copy setup prompt instead.');
      }
      await refreshAddedHosts();
    }
    else if (op === 'save-extension' || op === 'save-firefox-extension') {
      const folder = await refreshBrowserExtension(op === 'save-firefox-extension' ? 'firefox' : 'chrome', true);
      shell.showItemInFolder(folder);
      result = { saved: true, folder: path.basename(folder) };
    }
    else if (op === 'open-chrome-extensions' || op === 'open-firefox-extensions') result = await openExtensionsPage(op === 'open-chrome-extensions' ? 'chrome' : 'firefox');
    else if (op === 'copy-chrome-extensions' || op === 'copy-firefox-extensions') clipboard.writeText(EXTENSIONS_PAGES[op === 'copy-chrome-extensions' ? 'chrome' : 'firefox']);
    else if (op === 'open-jobstash') await shell.openExternal('https://jobstash.xyz');
    else fail('INVALID_INPUT', 'This settings action is unavailable.');
    emit(); return { ok: true, result };
  } catch (error) { return { ok: false, error: safeFailure(error) }; }
}
ipcMain.handle('local-settings', async (event, op, input = {}) => {
  if (event.sender !== window?.webContents || event.senderFrame !== window.webContents.mainFrame || event.senderFrame.url !== uiURL) throw new Error('Local settings only.');
  try {
    if (typeof op !== 'string') fail('INVALID_INPUT', 'Choose a local settings action.');
    if (op === 'state' || op.startsWith('update-')) return await settingsOperation(op, input);
    return await workGate.run(() => {
      if (['decisions-key-save', 'decisions-key-remove', 'publication-range-set', 'import-cv', 'cv-delete', 'delete-rankings', 'connect-account', 'backup', 'backup-preview', 'backup-restore'].includes(op))
        return mutation(ownMutation => settingsOperation(op, input, ownMutation));
      return settingsOperation(op, input);
    }, { meaningful: !['career-list', 'career-read', 'account-platform'].includes(op) });
  } catch (error) { return { ok: false, error: safeFailure(error) }; }
});
app.on('open-url', (event, url) => { event.preventDefault(); acceptPairingURL(url); });
if (!app.requestSingleInstanceLock({ localOnly })) app.quit();
else {
  app.on('second-instance', (_event, argv) => { const url = argv.find(value => value.startsWith('recruiters-companion:')); if (url) acceptPairingURL(url); else if (!argv.includes('--bridge') && !argv.includes('--mcp-background')) showSettings(); });
  app.on('activate', showSettings); app.on('window-all-closed', () => {});
  app.on('before-quit', event => {
    event.preventDefault();
    if (quitDraining) return;
    quitDraining = true; workGate.close({ drain: true }); updateScheduler.stop();
    browserForms.cancelAll(); pendingApproval?.finish(false);
    void (async () => {
      const handedOff = ['installing', 'launched'].includes(updates.state().status);
      // Abort background updates without holding Quit open for network or builds.
      if (!handedOff) void updates.cancel().catch(() => {});
      await workGate.drain();
      await Promise.allSettled([...mutations]);
      // Queue behind every accepted career write before allowing Electron to exit.
      if (vaultOpened) await vault.flush();
      exiting = true; clearInterval(heartbeatTimer); pairingReturn?.close(); mcpBridge?.close(); nativeBridge?.close();
      for (const socket of sockets) socket.destroy();
      // Saving and service teardown are complete. Do not re-enter AppKit's
      // window-close lifecycle: background windows may keep app.quit() alive.
      app.exit(0);
    })().catch(() => {
      if (updateInstalling) return;
      quitDraining = false; workGate.reopen();
      failure = 'The companion could not finish saving. Try quitting again.'; emit();
    });
  });
  void app.whenReady().then(async () => {
    // Exclude helper replacement/rollback before any profile, UI or service work.
    if (!await admitInstallationStartup()) { app.exit(0); return; }
    // A second live process would serve a separate in-memory vault and overwrite the first one's saves.
    if (!await claimInstance(directory)) { app.exit(0); return; }
    documents = createRequire(import.meta.url)('./generated/document-engine.cjs');
    Menu.setApplicationMenu(Menu.buildFromTemplate([{ label: 'Recruiters.rip Companion', submenu: [{ label: 'Settings', click: showSettings }, { type: 'separator' }, { role: 'quit' }] }, { role: 'editMenu' }]));
    // Render the recovery controls before local storage opens.
    // The settings page uses an in-memory browser session, never Chromium's
    // persistent cookie key. API credentials are entered only through the local settings IPC.
    await showSettings();
    await installConnections(); await startNativeBridge();
    mcpBridge = await startMcpBroker({ directory, createServer: createSessionServer, onConnections: clients => { mcpClients = clients; emit(); void refreshAddedHosts(); } });
    try { await initialize(); } catch (error) { failure = error?.code === 'LEGACY_VAULT_LOCKED' ? error.message : 'Local storage is unavailable. Check the companion data folder, then open local storage.'; }
    await refreshReviewHosts();
    heartbeatTimer = setInterval(() => {
      if (locked || heartbeatBusy || quitDraining || updateInstalling || !vault.get().pairing) return;
      heartbeatBusy = true;
      void workGate.run(() => client.request('POST', '/device/heartbeat', {}), { meaningful: false })
        .catch(() => {}).finally(() => { heartbeatBusy = false; });
    }, 30000);
    const lock = () => { backups.cancel(); browserForms.cancelAll(); sessionEpoch++; locked = true; pairingReturn?.close(); pendingApproval?.finish(false); mcpBridge.disconnect(); emit(); };
    const unlock = () => { if (screenLocked || sleeping) return; workGate.activity(); void initialize().then(startUpdates).then(() => emit()).catch(() => { failure = 'Local storage could not be reopened. Your saved data has not been replaced.'; }); };
    powerMonitor.on('lock-screen', () => { screenLocked = true; lock(); }); powerMonitor.on('suspend', () => { sleeping = true; lock(); });
    powerMonitor.on('unlock-screen', () => { screenLocked = false; unlock(); });
    powerMonitor.on('resume', () => { sleeping = false; unlock(); void updateScheduler.resume(); });
    const link = process.argv.find(value => value.startsWith('recruiters-companion:')); if (link) acceptPairingURL(link);
    if (queuedPairing && !locked) { const payload = queuedPairing; queuedPairing = undefined; void pair(payload).catch(error => { failure = safeFailure(error).message; emit(); }); }
    if ((process.argv.includes('--bridge') || process.argv.includes('--mcp-background')) && !locked && !pendingApproval) window.hide();
    else showSettings();
    // Confirm an installed update only after the window and local services work.
    coreReady = true;
    await startUpdates();
  }).catch(() => { console.error('Recruiters.rip Companion could not initialize its local MCP service. Reinstall the complete application.'); app.exit(1); });
}
