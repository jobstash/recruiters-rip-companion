import { app, BrowserWindow, ipcMain, powerMonitor, Menu, shell, clipboard, dialog } from 'electron';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFile, writeFile, chmod, unlink, mkdir } from 'node:fs/promises';
import { watch } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createVault, privateDirectory } from './vault.mjs';
import { createDeviceClient } from './client.mjs';
import { installNative, EXTENSION_ID } from './install-native.mjs';
import { CareerError, fail, upgradeCareer } from './mcp/state.mjs';
import { createMcpServer, createPlatformTools } from './mcp/server.mjs';
import { createProfileTools } from './mcp/profile-tools.mjs';
import { createApplicationTools } from './mcp/application-tools.mjs';
import { startMcpBroker } from './mcp/broker.mjs';
import { createDocumentFiles, readSelectedSource } from './mcp/files.mjs';
import { createScopedAccess } from './mcp/scope.mjs';
import { createMatchingTools, deleteRankings } from './mcp/matching-tools.mjs';
import { installChatGptPlugin } from './host-setup.mjs';
import { createCareerBrowser } from './career-browser.mjs';
import { createPrescanCredentials } from './prescan/credentials.mjs';
import { createPrescanController } from './prescan/service.mjs';
import { createPrescanTools } from './mcp/prescan-tools.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const packageMetadata = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const localOnly = packageMetadata.localProduct === true || (!app.isPackaged && process.argv.includes('--local-product'));
const productOrigin = localOnly ? 'http://127.0.0.1:3001' : 'https://recruiters.rip';
app.setName('Recruiters Companion');
// Local data is plain private JSON; keep Chromium from creating an OS keychain item.
app.commandLine.appendSwitch('use-mock-keychain');
// Keep the storage directory name stable across the visible brand rename.
const directory = path.join(app.getPath('userData'), localOnly ? 'local-device' : 'device');
const uiURL = pathToFileURL(path.join(root, 'ui', 'index.html')).href;
const vault = createVault(directory);
let window, client, nativeBridge, mcpBridge, documents, files, locked = true, failure = '';
let pendingApproval, confirmation = Promise.resolve(), initializing, exiting = false, screenLocked = false, sleeping = false;
let heartbeatTimer, heartbeatBusy = false, browserConnection = 'pending', queuedPairing;
let sessionEpoch = 0, careerViewRevision = 0;
let windowLoaded;
const sockets = new Set();
const store = { get() { assertAvailable(false); return vault.get(); }, update(change) { assertAvailable(false); return vault.update(async state => { assertAvailable(false); await change(state); assertAvailable(false); }); } };
let prescan, prescanViewState = '';
const prescanCredentials = createPrescanCredentials({ store, onChange: () => prescan?.cancel() });
prescan = createPrescanController({
  store, credentials: prescanCredentials,
  makeScope() {
    const scoped = createScopedAccess(store, { assertAvailable, epoch: () => sessionEpoch });
    return { store: scoped.store, assertAvailable: scoped.assertAvailable,
      platform: async (operation, args) => {
        scoped.assertAvailable(false);
        const result = await platform(operation, args);
        scoped.assertAvailable(false);
        return result;
      } };
  },
  authorize: ({ label, model, limit, inputUsdPerMillion }) => confirm('Run a paid job pre-scan?',
    `${label} (${model}) receives your CV, preferences, saved answers and complete job ads, including personal details.\n\nScan up to ${limit} jobs. OpenAI bills this separately from ChatGPT/Codex. Base rate: $${inputUsdPerMillion}/million input tokens; regional and long-context premiums may apply. The job limit is not a spending cap.\n\nResults are preliminary; Codex or Claude must review the ads. Cancel stops new requests, but sent requests may still be billed.`),
  onChange() {
    if (!prescan || locked) return;
    const current = prescan.status();
    const viewState = `${current.runId ?? ''}:${current.status}`;
    if (viewState !== prescanViewState) { prescanViewState = viewState; careerViewRevision++; }
    emit();
  },
});
function assertAvailable() {
  if (locked || screenLocked || sleeping) fail('LOCAL_LOCKED', 'Open Recruiters.rip Companion and unlock local storage. Your saved work is unchanged.');
}
function safeFailure(error) {
  const allowed = new Set(['DEVICE_OFFLINE', 'DEVICE_UNAUTHORIZED', 'DEVICE_REQUEST_FAILED', 'LOCAL_LOCKED', 'IDENTITY_CHANGED', 'NOT_FOUND', 'INVALID_INPUT', 'PAIRING_REQUIRED', 'CANCELLED', 'HOST_UNAVAILABLE', 'HOST_INSTALL_FAILED']);
  const known = error instanceof CareerError || allowed.has(error?.code);
  return { code: known ? error.code : 'LOCAL_OPERATION_FAILED', message: known ? error.message : 'This local action could not be completed. Saved career data is unchanged. Reopen the companion and try again.' };
}
function status() {
  if (locked) return { installed: true, mode: 'local_mcp', paired: false, connections: [], execution: { state: 'locked' } };
  const state = vault.get();
  return { installed: true, mode: 'local_mcp', deviceId: state.deviceId, publicKey: state.publicKey, label: state.label,
    paired: Boolean(state.pairing), connections: [], execution: { state: state.pairing ? 'ready' : 'needs_connection' } };
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
    setup: setup(), careerViewVersion: `${state.deviceId}:${sessionEpoch}:${careerViewRevision}`,
    prescan: { credentials: prescanCredentials.publicState(), run: prescan.status() },
    approval: pendingApproval ? { id: pendingApproval.id, title: pendingApproval.title, detail: pendingApproval.detail } : null };
}
function emit(event = 'status', payload = status()) {
  const bytes = encode({ version: 1, event, payload });
  for (const socket of sockets) if (!socket.destroyed) socket.write(bytes);
  if (window && !window.isDestroyed()) window.webContents.send('state-changed');
}
function showSettings() {
  if (window && !window.isDestroyed()) { window.show(); window.focus(); window.webContents.send('state-changed'); return windowLoaded; }
  window = new BrowserWindow({ width: 1180, height: 820, minWidth: 420, minHeight: 560, title: 'Recruiters.rip Companion', backgroundColor: '#0a0b0e',
    webPreferences: { preload: path.join(root, 'src', 'preload.cjs'), partition: 'recruiters-settings', nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, devTools: !app.isPackaged, spellcheck: false } });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.on('will-attach-webview', event => event.preventDefault());
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  window.webContents.session.setPermissionCheckHandler(() => false);
  window.webContents.session.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !details.url.startsWith(pathToFileURL(root + path.sep).href) }));
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
function confirm(title, detail) {
  const pending = confirmation.then(() => new Promise(resolve => {
    if (locked) { resolve(false); return; }
    const timer = setTimeout(() => pendingApproval?.finish(false), 120000);
    pendingApproval = { id: randomUUID(), title, detail, finish(allow) { clearTimeout(timer); pendingApproval = undefined; emit(); resolve(allow === true && !locked); } };
    showSettings();
  }));
  confirmation = pending.catch(() => false); return pending;
}
async function initialize() {
  if (screenLocked || sleeping) fail('LOCAL_LOCKED', 'Unlock this computer before opening saved career data.');
  if (!locked) return;
  if (initializing) return initializing;
  initializing = (async () => {
    await vault.open();
    await vault.update(state => { state.career = upgradeCareer(state.career); });
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
  if (existing && (existing.account.id !== pairing.account.id || existing.origin !== payload.productOrigin)) fail('INVALID_INPUT', 'This computer is paired with another account. Sign in with the account shown in the companion.');
  if (!await confirm('Connect this platform account?', `Account: ${JSON.stringify(pairing.account.label)}\nAccount ID: ${pairing.account.id}\nPlatform: ${payload.productOrigin}\n\nAn active membership permits this computer to read new job data. CVs, facts, matches and application drafts stay on this computer and remain available when membership ends. Your AI subscription remains with ChatGPT or Claude. No provider credential is requested.`)) fail('CANCELLED', 'Account connection canceled.');
  const activation = await client.request('POST', '/device/activate', { challenge: pairing.challenge, account: pairing.account }, { origin: payload.productOrigin });
  if (activation.deviceId !== pairing.deviceId || activation.account?.id !== pairing.account.id || activation.account?.label !== pairing.account.label) fail('INVALID_INPUT', 'The activated account does not match the local approval.');
  await store.update(state => { if (state.deviceId !== pairing.deviceId) fail('INVALID_INPUT', 'The device identity changed during pairing.'); state.pairing = { origin: payload.productOrigin, account: { ...pairing.account } }; });
  emit(); return status();
}
async function connectAccount() {
  assertAvailable(false); const state = store.get();
  const url = new URL('/settings/provider', productOrigin);
  if (!state.pairing) url.search = new URLSearchParams({ deviceId: state.deviceId, publicKey: state.publicKey, deviceLabel: state.label }).toString();
  await shell.openExternal(url.href);
  return { pairingRequired: !state.pairing };
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
    ...createApplicationTools({ store: scoped.store, platform: scopedPlatform, documents, exportDocument: localFiles.exportDocument }),
    ...createMatchingTools({ store: scoped.store, platform: scopedPlatform, exportDocument: localFiles.exportDocument }),
    ...createPrescanTools({ controller: Object.fromEntries(['start', 'cancel', 'status', 'results'].map(method => [method, async args => {
      scoped.assertAvailable(method === 'start' || method === 'cancel');
      const result = await prescan[method](args);
      scoped.assertAvailable(false);
      return result;
    }])) }),
  ];
  server = createMcpServer({ tools, assertAvailable: scoped.assertAvailable, readResource: localFiles.readResource, listResources: localFiles.listResources,
    notifyActivity: name => {
      if (tools.some(tool => tool.name === name && !tool.readOnly)) { careerViewRevision++; emit(); }
      if (name === 'career_rankings_delete') void prescan.cancel();
    } });
  return server;
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
ipcMain.handle('local-settings', async (event, op, input = {}) => {
  if (event.sender !== window?.webContents || event.senderFrame !== window.webContents.mainFrame || event.senderFrame.url !== uiURL) throw new Error('Local settings only.');
  try {
    if (op === 'state') return { ok: true, result: localState() };
    if (op === 'career-list' || op === 'career-read') {
      const scoped = createScopedAccess(store, { assertAvailable, epoch: () => sessionEpoch });
      const reader = createCareerBrowser({ store: scoped.store });
      const result = await (op === 'career-list' ? reader.list(input) : reader.read(input));
      scoped.assertAvailable(false);
      return { ok: true, result };
    }
    if (op.startsWith('prescan-')) {
      assertAvailable(false);
      let result;
      if (op === 'prescan-key-save') result = await prescanCredentials.save(input);
      else if (op === 'prescan-key-remove') result = await prescanCredentials.remove(input);
      else if (op === 'prescan-start') result = await prescan.start(input);
      else if (op === 'prescan-cancel') { exact(input, []); result = await prescan.cancel(); }
      else fail('INVALID_INPUT', 'This pre-scan action is unavailable.');
      emit(); return { ok: true, result };
    }
    exact(input, op === 'approval' ? ['id', 'allow'] : []);
    if (op === 'unlock') { await initialize(); if (queuedPairing) { const payload = queuedPairing; queuedPairing = undefined; void pair(payload).catch(error => { failure = safeFailure(error).message; emit(); }); } emit(); return { ok: true, result: localState() }; }
    assertAvailable(false); let result = { completed: true };
    if (op === 'approval') { if (!pendingApproval || pendingApproval.id !== input.id || typeof input.allow !== 'boolean') fail('INVALID_INPUT', 'This approval expired.'); pendingApproval.finish(input.allow); }
    else if (op === 'delete-rankings') { await prescan.cancel(); result = await deleteRankings(store); careerViewRevision++; }
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
    else if (op === 'copy-review-prompt') clipboard.writeText('Review my jobs using the saved pre-scan order. Do not reset rankings or pre-scan results. Read complete adverts before saving structured assessments, then rerank the top recommendations pairwise.');
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
    else fail('INVALID_INPUT', 'This settings action is unavailable.');
    emit(); return { ok: true, result };
  } catch (error) { return { ok: false, error: safeFailure(error) }; }
});
app.on('open-url', (event, url) => { event.preventDefault(); acceptPairingURL(url); });
if (!app.requestSingleInstanceLock({ localOnly })) app.quit();
else {
  app.on('second-instance', (_event, argv) => { const url = argv.find(value => value.startsWith('recruiters-companion:')); if (url) acceptPairingURL(url); else if (!argv.includes('--bridge') && !argv.includes('--mcp-background')) showSettings(); });
  app.on('activate', showSettings); app.on('window-all-closed', () => {});
  app.on('before-quit', () => { exiting = true; void prescan.cancel(); clearInterval(heartbeatTimer); pendingApproval?.finish(false); mcpBridge?.close(); nativeBridge?.close(); for (const socket of sockets) socket.destroy(); });
  void app.whenReady().then(async () => {
    documents = createRequire(import.meta.url)('./generated/document-engine.cjs');
    Menu.setApplicationMenu(Menu.buildFromTemplate([{ label: 'Recruiters.rip Companion', submenu: [{ label: 'Settings', click: showSettings }, { type: 'separator' }, { role: 'quit' }] }, { role: 'editMenu' }]));
    // Render the recovery controls before local storage opens.
    // The settings page uses an in-memory browser session, never Chromium's
    // persistent cookie key. API credentials are entered only through the local settings IPC.
    await showSettings();
    await installConnections(); await startNativeBridge();
    mcpBridge = await startMcpBroker({ directory, createServer: createSessionServer });
    try { await initialize(); } catch { failure = 'Local storage is unavailable. Check the companion data folder, then open local storage.'; }
    heartbeatTimer = setInterval(() => { if (locked || heartbeatBusy || !vault.get().pairing) return; heartbeatBusy = true; void client.request('POST', '/device/heartbeat', {}).catch(() => {}).finally(() => { heartbeatBusy = false; }); }, 30000);
    const lock = () => { void prescan.cancel(); sessionEpoch++; locked = true; pendingApproval?.finish(false); mcpBridge.disconnect(); emit(); };
    const unlock = () => { if (screenLocked || sleeping) return; void initialize().then(() => emit()).catch(() => { failure = 'Local storage could not be reopened. Your saved data has not been replaced.'; }); };
    powerMonitor.on('lock-screen', () => { screenLocked = true; lock(); }); powerMonitor.on('suspend', () => { sleeping = true; lock(); });
    powerMonitor.on('unlock-screen', () => { screenLocked = false; unlock(); }); powerMonitor.on('resume', () => { sleeping = false; unlock(); });
    const link = process.argv.find(value => value.startsWith('recruiters-companion:')); if (link) acceptPairingURL(link);
    if (queuedPairing && !locked) { const payload = queuedPairing; queuedPairing = undefined; void pair(payload).catch(error => { failure = safeFailure(error).message; emit(); }); }
    if ((process.argv.includes('--bridge') || process.argv.includes('--mcp-background')) && !locked && !pendingApproval) window.hide();
    else showSettings();
  }).catch(() => { console.error('Recruiters.rip Companion could not initialize its local MCP service. Reinstall the complete application.'); app.exit(1); });
}
