import { app, BrowserWindow, ipcMain, safeStorage, powerMonitor, Menu, shell, clipboard, dialog } from 'electron';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFile, writeFile, chmod, unlink, mkdir, rm } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createVault, privateDirectory } from './vault.mjs';
import { createDeviceClient } from './client.mjs';
import { installNative, EXTENSION_ID } from './install-native.mjs';
import { createCareerState, fail } from './mcp/state.mjs';
import { createMcpServer, createPlatformTools } from './mcp/server.mjs';
import { createProfileTools } from './mcp/profile-tools.mjs';
import { createApplicationTools } from './mcp/application-tools.mjs';
import { startMcpBroker } from './mcp/broker.mjs';
import { createDocumentFiles, readSelectedSource } from './mcp/files.mjs';
import { createScopedAccess } from './mcp/scope.mjs';
import { createMatchingTools } from './mcp/matching-tools.mjs';
import { installChatGptPlugin } from './host-setup.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const packageMetadata = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const localOnly = packageMetadata.localProduct === true || (!app.isPackaged && process.argv.includes('--local-product'));
const productOrigin = localOnly ? 'http://127.0.0.1:3001' : 'https://recruiters.rip';
app.setName('Recruiters Companion');
// Keep the OS storage/keychain identity stable across the visible brand rename.
const directory = path.join(app.getPath('userData'), localOnly ? 'local-device' : 'device');
const uiURL = pathToFileURL(path.join(root, 'ui', 'index.html')).href;
const vault = createVault(safeStorage, directory);
let window, client, nativeBridge, mcpBridge, documents, files, locked = true, failure = '', mcpConnections = 0;
let pendingApproval, confirmation = Promise.resolve(), initializing, exiting = false, screenLocked = false, sleeping = false;
let heartbeatTimer, heartbeatBusy = false, browserConnection = 'pending', lastTool = null, queuedPairing;
let sessionEpoch = 0, pauseRequested = false;
let windowLoaded;
const sockets = new Set();
const store = { get() { assertAvailable(false); return vault.get(); }, update(change) { assertAvailable(false); return vault.update(async state => { assertAvailable(false); await change(state); assertAvailable(false); }); } };
function assertAvailable(mutation) {
  if (locked || !vault.available() || screenLocked || sleeping) fail('LOCAL_LOCKED', 'Open Recruiters.rip Companion and unlock local storage. Your saved work is unchanged.');
  if (mutation && (pauseRequested || vault.get().userPaused)) fail('LOCAL_PAUSED', 'Local changes are paused. Choose Resume work in Recruiters.rip Companion.');
}
function safeFailure(error) {
  const allowed = new Set(['DEVICE_OFFLINE', 'DEVICE_UNAUTHORIZED', 'DEVICE_REQUEST_FAILED', 'LOCAL_LOCKED', 'LOCAL_PAUSED', 'INVALID_INPUT', 'PAIRING_REQUIRED', 'CANCELLED', 'HOST_UNAVAILABLE', 'HOST_INSTALL_FAILED']);
  return { code: allowed.has(error?.code) ? error.code : 'LOCAL_OPERATION_FAILED', message: allowed.has(error?.code) ? error.message : 'This local action could not be completed. Saved career data is unchanged. Reopen the companion and try again.' };
}
function status() {
  if (locked || !vault.available()) return { installed: true, mode: 'local_mcp', paired: false, connections: [], execution: { state: 'locked' } };
  const state = vault.get();
  return { installed: true, mode: 'local_mcp', deviceId: state.deviceId, publicKey: state.publicKey, label: state.label,
    paired: Boolean(state.pairing), connections: [], execution: { state: state.userPaused ? 'paused' : state.pairing ? 'ready' : 'needs_connection' } };
}
function setup() {
  const command = path.join(directory, 'recruiters-rip-mcp');
  return { command, claudeConfig: JSON.stringify({ mcpServers: { 'recruiters-rip': { command, args: [] } } }, null, 2),
    claudePackage: path.join(app.isPackaged ? root.replace(/app\.asar$/, 'app.asar.unpacked') : root, 'src', 'generated', localOnly ? 'recruiters-rip-local.mcpb' : 'recruiters-rip.mcpb') };
}
function localState() {
  const publicState = status();
  if (locked) return { ...publicState, failure, browserConnection };
  const state = vault.get();
  return { ...publicState, account: state.pairing?.account ?? null, origin: state.pairing?.origin ?? null, browserConnection, failure,
    mcpConnections, lastTool, setup: setup(), career: { revision: state.career.revision, sources: Object.keys(state.career.sources).length,
      facts: Object.values(state.career.facts).filter(fact => fact.status === 'active').length, applications: Object.keys(state.career.applications).length },
    archivedIdentities: Object.keys(state.identityArchives ?? {}).length,
    approval: pendingApproval ? { id: pendingApproval.id, title: pendingApproval.title, detail: pendingApproval.detail } : null };
}
function emit(event = 'status', payload = status()) {
  const bytes = encode({ version: 1, event, payload });
  for (const socket of sockets) if (!socket.destroyed) socket.write(bytes);
  if (window && !window.isDestroyed()) window.webContents.send('state-changed');
}
function showSettings() {
  if (window && !window.isDestroyed()) { window.show(); window.focus(); window.webContents.send('state-changed'); return windowLoaded; }
  window = new BrowserWindow({ width: 780, height: 860, minWidth: 420, minHeight: 560, title: 'Recruiters.rip Companion', backgroundColor: '#fafafa',
    webPreferences: { preload: path.join(root, 'src', 'preload.cjs'), partition: 'recruiters-settings', nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, devTools: !app.isPackaged, spellcheck: false } });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.on('will-attach-webview', event => event.preventDefault());
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  window.webContents.session.setPermissionCheckHandler(() => false);
  window.webContents.session.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !details.url.startsWith(pathToFileURL(root + path.sep).href) }));
  window.on('close', event => { if (!exiting) { event.preventDefault(); window.hide(); } });
  windowLoaded = window.loadURL(uiURL);
  return windowLoaded;
}
function confirm(title, detail) {
  const pending = confirmation.then(() => new Promise(resolve => {
    if (locked) { resolve(false); return; }
    const timer = setTimeout(() => pendingApproval?.finish(false), 120000);
    pendingApproval = { id: randomUUID(), title, detail, finish(allow) { clearTimeout(timer); pendingApproval = undefined; emit(); resolve(allow === true && !locked); } };
    showSettings();
  }));
  confirmation = pending.catch(() => false); return pending;
}
async function setPaused(paused) {
  assertAvailable(false);
  if (paused) pauseRequested = true;
  try { await store.update(state => { state.userPaused = paused; }); }
  finally { pauseRequested = vault.get().userPaused; }
  if (paused) pendingApproval?.finish(false);
  emit('work_revoked', {}); emit();
}
async function initialize() {
  if (screenLocked || sleeping) fail('LOCAL_LOCKED', 'Unlock this computer before opening saved career data.');
  if (!locked) return;
  if (initializing) return initializing;
  initializing = (async () => {
    await vault.open();
    await vault.update(state => {
      state.career ??= createCareerState();
      delete state.career.evaluationRuns;
      for (const [id, receipt] of Object.entries(state.career.receipts))
        if (receipt.operation.startsWith('career_evaluation_')) delete state.career.receipts[id];
    });
    await rm(path.join(directory, 'career-files', vault.get().deviceId, 'evaluations'), { recursive: true, force: true });
    if (screenLocked || sleeping) fail('LOCAL_LOCKED', 'Unlock this computer before opening saved career data.');
    locked = false; failure = ''; client = createDeviceClient(store, localOnly);
    files = createDocumentFiles({ directory, store, assertAvailable });
  })();
  try { await initializing; } finally { initializing = undefined; }
}
function object(value) { if (!value || typeof value !== 'object' || Array.isArray(value)) fail('INVALID_INPUT', 'Use the supported operation fields.'); return value; }
function exact(value, keys) { object(value); if (Object.keys(value).some(key => !keys.includes(key))) fail('INVALID_INPUT', 'Unsupported operation fields.'); }
async function pair(payload) {
  assertAvailable(false); exact(payload, ['productOrigin', 'pairing']);
  const pairing = object(payload.pairing); exact(pairing, ['deviceId', 'challenge', 'expiresAt', 'account']);
  const expiry = typeof pairing.expiresAt === 'number' ? pairing.expiresAt : Date.parse(pairing.expiresAt);
  if (payload.productOrigin !== productOrigin || pairing.deviceId !== store.get().deviceId || !Number.isFinite(expiry) || expiry <= Date.now() || expiry > Date.now() + 301000 || typeof pairing.challenge !== 'string' || pairing.challenge.length > 512 || !pairing.account || typeof pairing.account.id !== 'string' || pairing.account.id.length > 200 || typeof pairing.account.label !== 'string' || pairing.account.label.length > 240) fail('INVALID_INPUT', 'The account pairing link is invalid or expired. Start a new connection from local settings.');
  exact(pairing.account, ['id', 'label']);
  const existing = store.get().pairing;
  if (existing && (existing.account.id !== pairing.account.id || existing.origin !== payload.productOrigin)) fail('INVALID_INPUT', 'This computer is paired with another account. Reset its identity in local settings before switching accounts.');
  if (!await confirm('Connect this platform account?', `Account: ${JSON.stringify(pairing.account.label)}\nAccount ID: ${pairing.account.id}\nPlatform: ${payload.productOrigin}\n\nAn active membership permits this computer to read new job data. CVs, facts, matches and application drafts stay on this computer and remain available when membership ends. Your AI subscription remains with ChatGPT or Claude. No provider credential is requested.`)) fail('CANCELLED', 'Account connection canceled.');
  const activation = await client.request('POST', '/device/activate', { challenge: pairing.challenge, account: pairing.account }, { origin: payload.productOrigin });
  if (activation.deviceId !== pairing.deviceId || activation.account?.id !== pairing.account.id || activation.account?.label !== pairing.account.label) fail('INVALID_INPUT', 'The activated account does not match the local approval.');
  await store.update(state => { if (state.deviceId !== pairing.deviceId) fail('INVALID_INPUT', 'The device identity changed during pairing.'); state.pairing = { origin: payload.productOrigin, account: { ...pairing.account } }; });
  emit(); return status();
}
async function connectAccount() {
  assertAvailable(false); const state = store.get();
  const url = new URL('/settings/provider', productOrigin);
  url.search = new URLSearchParams({ deviceId: state.deviceId, publicKey: state.publicKey, deviceLabel: state.label }).toString();
  await shell.openExternal(url.href);
}
function acceptPairingURL(raw) {
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
  if (!store.get().pairing) fail('PAIRING_REQUIRED', 'Use account_connect to connect your platform account. Your local profile remains available.');
  return client.request('POST', '/device/platform', { operation, args });
}
async function selectSourceFile() {
  assertAvailable(true); showSettings();
  const result = await dialog.showOpenDialog(window, { title: 'Choose your source CV', properties: ['openFile'], filters: [{ name: 'CV documents', extensions: ['pdf', 'docx', 'txt'] }] });
  assertAvailable(true);
  return result.canceled || !result.filePaths[0] ? null : readSelectedSource(result.filePaths[0]);
}
function createSessionServer() {
  const scoped = createScopedAccess(store, { assertAvailable, epoch: () => sessionEpoch });
  const localFiles = createDocumentFiles({ directory, store: scoped.store, assertAvailable: scoped.assertAvailable });
  const scopedPlatform = async (operation, args) => {
    scoped.assertAvailable(false); const result = await platform(operation, args); scoped.assertAvailable(false); return result;
  };
  const tools = [
    ...createPlatformTools({ store: scoped.store, platform: scopedPlatform, connectAccount, openSettings: showSettings }),
    ...createProfileTools({ store: scoped.store, selectSourceFile: async () => {
      scoped.assertAvailable(true); const result = await selectSourceFile(); scoped.assertAvailable(true); return result;
    }, extractFile: documents.extractFile }),
    ...createApplicationTools({ store: scoped.store, platform: scopedPlatform, documents, exportDocument: localFiles.exportDocument }),
    ...createMatchingTools({ store: scoped.store, platform: scopedPlatform, exportDocument: localFiles.exportDocument }),
  ];
  return createMcpServer({ tools, assertAvailable: scoped.assertAvailable, readResource: localFiles.readResource, listResources: localFiles.listResources,
    notifyActivity: name => { lastTool = { name, at: new Date().toISOString() }; emit(); } });
}
async function installConnections() {
  await privateDirectory(directory);
  const launch = { executable: process.execPath, args: [...(app.isPackaged ? [] : [app.getAppPath()]), ...(localOnly ? ['--local-product'] : [])], localOnly };
  await writeFile(path.join(directory, 'mcp-launch.json'), JSON.stringify(launch), { mode: 0o600 });
  await chmod(path.join(directory, 'mcp-launch.json'), 0o600);
  const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
  const script = path.join(app.isPackaged ? app.getAppPath().replace(/app\.asar$/, 'app.asar.unpacked') : app.getAppPath(), 'src', 'generated', 'mcp-host.cjs');
  await writeFile(setup().command, `#!/bin/sh\nexec env ELECTRON_RUN_AS_NODE=1 ${quote(process.execPath)} ${quote(script)}${localOnly ? ' --local-product' : ''}\n`, { mode: 0o700 });
  await chmod(setup().command, 0o700);
  try { await unlink(path.join(directory, 'recruiters-mcp')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  app.setAsDefaultProtocolClient('recruiters-companion', process.execPath, app.isPackaged ? [] : [app.getAppPath(), ...(localOnly ? ['--local-product'] : [])]);
  try { await installNative({ executable: process.execPath, appPath: app.getAppPath(), directory, packaged: app.isPackaged, localOnly }); browserConnection = 'installed'; }
  catch { browserConnection = 'unavailable'; }
}
async function nativeOperation(op, payload) {
  exact(payload, op === 'pair' ? ['productOrigin', 'pairing'] : []);
  if (op === 'status') return status();
  if (op === 'open_settings') { showSettings(); return { opened: true }; }
  if (op === 'pair') return pair(payload);
  fail('INVALID_INPUT', 'Provider inference and browser control are not available through this connection. Continue in your connected ChatGPT or Claude app.');
}
function encode(value) { const data = Buffer.from(JSON.stringify(value)); if (data.length > 1024 * 1024 - 1024) throw new Error('Native response too large.'); const header = Buffer.allocUnsafe(4); header.writeUInt32LE(data.length); return Buffer.concat([header, data]); }
async function startNativeBridge() {
  const token = randomBytes(32).toString('hex'), socketPath = path.join(directory, 'native.sock');
  try { await unlink(socketPath); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  nativeBridge = net.createServer(socket => {
    let authenticated = false, input = Buffer.alloc(0), pending = 0;
    const timer = setTimeout(() => { if (!authenticated) socket.destroy(); }, 5000);
    socket.on('error', () => socket.destroy()); socket.on('close', () => { clearTimeout(timer); sockets.delete(socket); });
    socket.on('data', chunk => {
      input = Buffer.concat([input, chunk]); if (input.length > 65536) { socket.destroy(); return; }
      while (input.length >= 4) {
        const length = input.readUInt32LE(0); if (!length || length > 65532) { socket.destroy(); return; } if (input.length < length + 4) return;
        let message; try { message = JSON.parse(input.subarray(4, length + 4).toString('utf8')); } catch { socket.destroy(); return; } input = input.subarray(length + 4);
        if (!authenticated) {
          const supplied = typeof message.auth === 'string' ? Buffer.from(message.auth) : Buffer.alloc(0);
          if (message.origin !== `chrome-extension://${EXTENSION_ID}/` || supplied.length !== token.length || !timingSafeEqual(supplied, Buffer.from(token))) { socket.destroy(); return; }
          authenticated = true; clearTimeout(timer); sockets.add(socket); continue;
        }
        if (message.version !== 1 || typeof message.id !== 'string' || message.id.length > 100 || typeof message.op !== 'string' || ++pending > 8) { socket.destroy(); return; }
        void nativeOperation(message.op, message.payload).then(result => ({ version: 1, id: message.id, ok: true, result }), error => ({ version: 1, id: message.id, ok: false, error: safeFailure(error) }))
          .then(reply => { if (!socket.destroyed) socket.write(encode(reply)); }).finally(() => { pending--; }).catch(() => socket.destroy());
      }
    });
  });
  await new Promise((resolve, reject) => { nativeBridge.once('error', reject); nativeBridge.listen(socketPath, resolve); });
  await chmod(socketPath, 0o600); await writeFile(path.join(directory, 'bridge.json'), JSON.stringify({ socket: socketPath, token }), { mode: 0o600 }); await chmod(path.join(directory, 'bridge.json'), 0o600);
}
async function resetPairing() {
  assertAvailable(false); const state = store.get();
  if (!await confirm('Reset this device identity?', `This disconnects local MCP clients and archives the current local profile, sources, facts and drafts under device ${state.deviceId}. Archives remain available in a local career backup, but are not exposed to a new account.\n\nA new identity starts with an empty local profile. Existing platform records are not deleted. Revoke the old device in your platform account separately.`)) fail('CANCELLED', 'Device reset canceled.');
  sessionEpoch++; mcpBridge.disconnect(); const result = await vault.resetIdentity(); pauseRequested = false; emit(); return result;
}
ipcMain.handle('local-settings', async (event, op, input = {}) => {
  if (event.sender !== window?.webContents || event.senderFrame !== window.webContents.mainFrame || event.senderFrame.url !== uiURL) throw new Error('Local settings only.');
  try {
    if (op === 'state') return { ok: true, result: localState() };
    exact(input, op === 'approval' ? ['id', 'allow'] : []);
    if (op === 'unlock') { await initialize(); if (queuedPairing) { const payload = queuedPairing; queuedPairing = undefined; void pair(payload).catch(error => { failure = safeFailure(error).message; emit(); }); } emit(); return { ok: true, result: localState() }; }
    assertAvailable(false); let result = { completed: true };
    if (op === 'approval') { if (!pendingApproval || pendingApproval.id !== input.id || typeof input.allow !== 'boolean') fail('INVALID_INPUT', 'This approval expired.'); pendingApproval.finish(input.allow); }
    else if (op === 'pause') await setPaused(true);
    else if (op === 'resume') await setPaused(false);
    else if (op === 'connect-account') await connectAccount();
    else if (op === 'copy-command') clipboard.writeText(setup().command);
    else if (op === 'copy-config') clipboard.writeText(setup().claudeConfig);
    else if (op === 'install-chatgpt') result = await installChatGptPlugin({ directory, root: app.isPackaged ? root.replace(/app\.asar$/, 'app.asar.unpacked') : root, localOnly, command: setup().command });
    else if (op === 'install-claude') { const error = await shell.openPath(setup().claudePackage); if (error) fail('INVALID_INPUT', 'The Claude extension could not be opened. Use the displayed local MCP configuration instead.'); }
    else if (op === 'open-exports') { const dir = files.exportDirectory(); await privateDirectory(dir); const error = await shell.openPath(dir); if (error) throw new Error(error); }
    else if (op === 'backup') {
      const target = await dialog.showSaveDialog(window, { title: 'Export local career backup', defaultPath: 'recruiters-career-backup.json', filters: [{ name: 'Career data', extensions: ['json'] }] });
      if (!target.canceled && target.filePath) { assertAvailable(false); const state = store.get(); const backups = Object.entries(state.identityArchives ?? {}).map(([deviceId, archived]) => ({ deviceId, account: archived.pairing?.account, career: archived.career })); await writeFile(target.filePath, JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), account: state.pairing?.account, career: state.career, archives: backups }, null, 2), { mode: 0o600 }); await chmod(target.filePath, 0o600); }
      result = { exported: !target.canceled };
    }
    else if (op === 'unpair') result = await resetPairing();
    else if (op === 'install-native') await installConnections();
    else fail('INVALID_INPUT', 'This settings action is unavailable.');
    emit(); return { ok: true, result };
  } catch (error) { return { ok: false, error: safeFailure(error) }; }
});
app.on('open-url', (event, url) => { event.preventDefault(); acceptPairingURL(url); });
if (!app.requestSingleInstanceLock({ localOnly })) app.quit();
else {
  app.on('second-instance', (_event, argv) => { const url = argv.find(value => value.startsWith('recruiters-companion:')); if (url) acceptPairingURL(url); else if (!argv.includes('--bridge') && !argv.includes('--mcp-background')) showSettings(); });
  app.on('activate', showSettings); app.on('window-all-closed', () => {});
  app.on('before-quit', () => { exiting = true; clearInterval(heartbeatTimer); pendingApproval?.finish(false); mcpBridge?.close(); nativeBridge?.close(); for (const socket of sockets) socket.destroy(); });
  void app.whenReady().then(async () => {
    documents = createRequire(import.meta.url)('./generated/document-engine.cjs');
    Menu.setApplicationMenu(Menu.buildFromTemplate([{ label: 'Recruiters.rip Companion', submenu: [{ label: 'Settings', click: showSettings }, { label: 'Pause local changes', click: () => void setPaused(true).catch(error => { failure = safeFailure(error).message; showSettings(); emit(); }) }, { type: 'separator' }, { role: 'quit' }] }, { role: 'editMenu' }]));
    // Render the recovery controls before OS key storage can request approval.
    // The settings page uses an in-memory browser session, never Chromium's
    // persistent cookie key, and contains no provider authentication.
    await showSettings();
    await installConnections(); await startNativeBridge();
    mcpBridge = await startMcpBroker({ directory, createServer: createSessionServer, onConnections: count => { mcpConnections = count; emit(); } });
    try { await initialize(); } catch { failure = 'Local encrypted storage is unavailable. Unlock your operating system key storage, then open local storage.'; }
    heartbeatTimer = setInterval(() => { if (locked || heartbeatBusy || !vault.get().pairing) return; heartbeatBusy = true; void client.request('POST', '/device/heartbeat', {}).catch(() => {}).finally(() => { heartbeatBusy = false; }); }, 30000);
    const lock = () => { sessionEpoch++; locked = true; pendingApproval?.finish(false); mcpBridge.disconnect(); emit(); };
    const unlock = () => { if (screenLocked || sleeping) return; void initialize().then(() => emit()).catch(() => { failure = 'Unlock operating system key storage to reopen your local career data.'; }); };
    powerMonitor.on('lock-screen', () => { screenLocked = true; lock(); }); powerMonitor.on('suspend', () => { sleeping = true; lock(); });
    powerMonitor.on('unlock-screen', () => { screenLocked = false; unlock(); }); powerMonitor.on('resume', () => { sleeping = false; unlock(); });
    const link = process.argv.find(value => value.startsWith('recruiters-companion:')); if (link) acceptPairingURL(link);
    if (queuedPairing && !locked) { const payload = queuedPairing; queuedPairing = undefined; void pair(payload).catch(error => { failure = safeFailure(error).message; emit(); }); }
    if ((process.argv.includes('--bridge') || process.argv.includes('--mcp-background')) && !locked && !pendingApproval) window.hide();
    else showSettings();
  }).catch(() => { console.error('Recruiters.rip Companion could not initialize its local MCP service. Reinstall the complete application.'); app.exit(1); });
}
