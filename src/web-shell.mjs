// Stand-ins for the Electron APIs the main process uses, backed by a browser UI over loopback HTTP.
// The screens are the same `ui/` files; `ui/web-shell.js` replaces the preload bridge and carries out
// the browser's half of each stand-in (file picker, confirmation, opening links and files, clipboard).
import { createServer } from 'node:http';
import { AsyncLocalStorage } from 'node:async_hooks';
import { EventEmitter } from 'node:events';
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import platformRuntime from './platform-runtime.cjs';

const { supportDirectory, protectPrivatePath, privateJSON } = platformRuntime;
export const WEB_SHELL_DEFAULT_PORT = 43117;
const SESSION_COOKIE = 'rr_companion';
const SESSION_SECONDS = 30 * 24 * 60 * 60;
const MAX_INVOKE_BYTES = 512 * 1024, MAX_UPLOAD_BYTES = 130 * 1024 * 1024;
const DIALOG_TIMEOUT = 5 * 60_000, FILE_TIMEOUT = 10 * 60_000;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const types = { '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.woff2': 'font/woff2',
  '.png': 'image/png', '.ico': 'image/x-icon', '.webp': 'image/webp' };
const downloads = { '.pdf': 'application/pdf', '.txt': 'text/plain; charset=utf-8', '.json': 'application/json', '.zip': 'application/zip', '.csv': 'text/csv; charset=utf-8' };
const pageSecurity = "default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' https:; connect-src 'self'; form-action 'none'; base-uri 'none'; frame-src 'none'; object-src 'none'; frame-ancestors 'none'";
const equal = (left, right) => { const a = Buffer.from(String(left)), b = Buffer.from(String(right)); return a.length === b.length && timingSafeEqual(a, b); };

const signInPage = hint => `<!doctype html><html lang="en" data-theme="dark"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>recruiters.rip</title><link rel="stylesheet" href="/design-tokens.css"><link rel="stylesheet" href="/settings.css"><script src="/web-signin.js" defer></script></head><body><header class="topbar"><div class="brand"><img class="brand-lockup" src="/brand/recruiters-rip-lockup-reversed.svg" alt="recruiters.rip" width="180" height="32"><span class="brand-sub">Companion</span></div></header><main><div class="page-heading"><h1>Open Companion</h1><p id="signin-status" role="status" aria-live="polite">${hint}</p></div><form id="signin" autocomplete="off"><label class="decisions-field" for="signin-code"><span>Access code</span><input id="signin-code" type="password" autocomplete="off" autocapitalize="none" spellcheck="false" required></label><div class="actions"><button class="primary" type="submit">Open Companion</button></div></form></main></body></html>`;

export function createWebShell({ argv = process.argv, env = process.env, root = path.dirname(path.dirname(fileURLToPath(import.meta.url))),
  exit = code => process.exit(code), log = message => console.log(message), signals = process } = {}) {
  const requestedPort = Number(env.RECRUITERS_COMPANION_WEB_PORT);
  let port = Number.isInteger(requestedPort) && ((requestedPort >= 1024 && requestedPort <= 65535) || requestedPort === 0) ? requestedPort : WEB_SHELL_DEFAULT_PORT;
  // A container publishes the port, so it must listen on every interface there; the published side stays on loopback.
  const bind = env.RECRUITERS_COMPANION_WEB_BIND === '0.0.0.0' ? '0.0.0.0' : '127.0.0.1';
  const container = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/.test(env.RECRUITERS_COMPANION_CONTAINER ?? '') ? env.RECRUITERS_COMPANION_CONTAINER : null;
  const profileArgument = argv.find(value => typeof value === 'string' && value.startsWith('--user-data-dir='));
  const userData = profileArgument ? path.resolve(profileArgument.slice('--user-data-dir='.length))
    : typeof env.RECRUITERS_COMPANION_DATA === 'string' && path.isAbsolute(env.RECRUITERS_COMPANION_DATA) ? env.RECRUITERS_COMPANION_DATA
    : path.join(supportDirectory({ env }), 'Recruiters Companion');
  const stateDirectory = path.join(userData, 'web-shell'), uploads = path.join(stateDirectory, 'uploads');
  const ui = path.join(root, 'ui');

  const events = new EventEmitter(), handlers = new Map(), routes = new Set();
  const clients = new Map(), dialogs = new Map(), files = new Map();
  const context = new AsyncLocalStorage();
  let server, token = '', ready = false, starting, latestClient, mainWindow, heartbeat;
  const origin = () => `http://127.0.0.1:${port}`;

  // Events reach the tab that asked; work started elsewhere (an AI app, the extension) reaches the most recent tab.
  const target = () => clients.get(context.getStore()?.client) ?? clients.get(latestClient) ?? [...clients.values()].at(-1);
  const write = (client, event, data = {}) => { if (client && !client.destroyed) client.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };
  const broadcast = (event, data) => { for (const client of clients.values()) write(client, event, data); };

  async function privateFolder(directory) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    protectPrivatePath(directory, { directory: true });
  }

  // A file link is its own key: unguessable, short-lived, and usable by whichever browser the extension runs in.
  async function shareFile(filename, { download = false, name = path.basename(filename) } = {}) {
    if (!(await stat(filename)).isFile()) throw new Error('Folders cannot be opened from the browser.');
    const id = randomBytes(24).toString('base64url');
    const timer = setTimeout(() => files.delete(id), FILE_TIMEOUT); timer.unref();
    files.set(id, { filename, name, download, timer });
    return { path: `/files/${id}/${encodeURIComponent(name)}`, name, download };
  }
  /** Offer a local file to the browser: shown in a tab, or saved through the browser's own download. Returns '' or why not. */
  async function offerFile(filename, options) {
    const client = target();
    if (!client) return 'Open Companion in your browser, then try again.';
    let shared;
    try { shared = await shareFile(filename, options); } catch { return 'This file cannot be opened from the browser.'; }
    write(client, 'open-file', { url: shared.path, name: shared.name, download: shared.download });
    return '';
  }

  function ask(kind, details, fallback) {
    return new Promise(resolve => {
      const id = randomUUID();
      const finish = value => {
        if (dialogs.get(id) !== entry) return;
        dialogs.delete(id); clearTimeout(entry.timer); broadcast('dialog-closed', { id }); resolve(value);
      };
      const entry = { id, kind, details, fallback, finish, timer: setTimeout(() => finish(fallback), DIALOG_TIMEOUT) };
      entry.timer.unref();
      dialogs.set(id, entry);
      // Without an open tab the request waits; the next tab to connect receives it.
      write(target(), 'dialog', { id, kind, ...details });
    });
  }
  const options = (first, second) => second ?? (first && !(first instanceof WebWindow) ? first : {});

  class WebWindow {
    constructor() {
      mainWindow = this;
      this.webContents = {
        mainFrame: { url: '' },
        send: (channel, ...values) => broadcast(channel, values.length <= 1 ? values[0] ?? {} : values),
        on() {}, setWindowOpenHandler() {}, reloadIgnoringCache: () => broadcast('reload'),
        session: { setPermissionRequestHandler() {}, setPermissionCheckHandler() {}, webRequest: { onBeforeRequest() {} } },
      };
    }
    loadURL(url) { this.webContents.mainFrame.url = url; return Promise.resolve(); }
    show() {} focus() {} hide() {} on() {}
    isDestroyed() { return false; }
  }

  const app = {
    isPackaged: false,
    setName() {},
    getAppPath: () => root,
    getPath(name) {
      if (name === 'userData') return userData;
      if (name === 'downloads') return path.join(os.homedir(), 'Downloads');
      throw new Error(`Unsupported path: ${name}`);
    },
    commandLine: { appendSwitch() {} },
    requestSingleInstanceLock: () => true,
    setAsDefaultProtocolClient: () => false,
    getApplicationInfoForProtocol: async () => { throw new Error('No desktop applications are reachable from the web shell.'); },
    isReady: () => ready,
    whenReady: () => starting ??= start(),
    on(event, listener) { events.on(event, listener); return app; },
    quit() {
      const event = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
      events.emit('before-quit', event);
      if (!event.defaultPrevented) app.exit(0);
    },
    exit(code = 0) { void close().finally(() => exit(code)); },
  };

  const shell = {
    async openExternal(url) {
      const client = target();
      if (typeof url !== 'string' || !client) throw new Error('Open Companion in your browser, then try again.');
      write(client, 'open-link', { url });
    },
    openPath: filename => offerFile(filename),
    showItemInFolder(filename) { void offerFile(filename, { download: true }); },
  };
  const clipboard = { writeText(text) { write(target(), 'copy-text', { text: String(text) }); } };
  const dialog = {
    showOpenDialog(first, second) {
      const { title = 'Choose a file', filters = [] } = options(first, second);
      return ask('open', { title, extensions: filters.flatMap(filter => filter.extensions ?? []).map(value => String(value).toLowerCase()) }, { canceled: true, filePaths: [] });
    },
    // The file is written to its default place inside Companion's storage, then offered as a browser download.
    async showSaveDialog(first, second) {
      const { defaultPath } = options(first, second);
      if (typeof defaultPath !== 'string' || !path.isAbsolute(defaultPath)) return { canceled: true };
      context.getStore()?.saves.push(defaultPath);
      return { canceled: false, filePath: defaultPath };
    },
    showMessageBox(first, second) {
      const { type = 'none', message = '', detail = '', buttons = ['OK'], defaultId = 0, cancelId = 0 } = options(first, second);
      return ask('message', { type, message, detail, buttons, defaultId, cancelId }, { response: cancelId });
    },
  };

  // A session is the access code's signature over its own expiry, so a browser stays signed in when Companion restarts.
  const sign = expires => createHmac('sha256', token).update(`session:${expires}`).digest('base64url');
  function signedIn(req) {
    const value = (req.headers.cookie ?? '').split(';').map(part => part.trim().split('=')).find(([name]) => name === SESSION_COOKIE)?.[1] ?? '';
    const [expires, signature] = value.split('.');
    return /^\d{13}$/.test(expires ?? '') && Number(expires) > Date.now() && equal(signature ?? '', sign(expires));
  }
  async function body(req, limit) {
    const chunks = []; let bytes = 0;
    for await (const chunk of req) {
      bytes += chunk.length;
      if (bytes > limit) throw Object.assign(new Error('Request too large.'), { status: 413 });
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }
  async function json(req, limit) {
    if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) throw Object.assign(new Error('JSON required.'), { status: 415 });
    let value;
    try { value = JSON.parse((await body(req, limit)).toString('utf8')); } catch (error) { throw error.status ? error : Object.assign(new Error('Invalid JSON.'), { status: 400 }); }
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw Object.assign(new Error('Invalid JSON.'), { status: 400 });
    return value;
  }
  const reply = (res, status, value, headers = {}) => { res.writeHead(status, { 'Content-Type': 'application/json', ...headers }); res.end(JSON.stringify(value ?? {})); };

  async function appPage() {
    const html = await readFile(path.join(ui, 'index.html'), 'utf8');
    // The desktop window forbids every connection; the browser needs exactly this origin for the bridge.
    const allowed = html.replace("connect-src 'none'", "connect-src 'self'").replace('<script ', '<script src="web-shell.js"></script>\n<script ');
    if (allowed === html || !allowed.includes("connect-src 'self'")) throw new Error('The settings page cannot host the web bridge.');
    return allowed;
  }
  async function asset(res, pathname) {
    const filename = path.join(ui, path.normalize(pathname));
    const type = types[path.extname(filename)];
    if (!type || !filename.startsWith(ui + path.sep)) return false;
    let content;
    try { content = await readFile(filename); } catch { return false; }
    res.writeHead(200, { 'Content-Type': type }); res.end(content);
    return true;
  }

  async function upload(req, res, entry) {
    let name;
    try { name = path.basename(decodeURIComponent(String(req.headers['x-file-name'] ?? ''))).replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 200); } catch { name = ''; }
    const extension = path.extname(name).slice(1).toLowerCase();
    if (!name || name.startsWith('.') || (entry.details.extensions.length && !entry.details.extensions.includes(extension))) { reply(res, 400, { error: 'Choose a supported file.' }); return; }
    const folder = path.join(uploads, entry.id), filename = path.join(folder, name);
    await privateFolder(folder);
    let bytes = 0, failed = false;
    const output = createWriteStream(filename, { mode: 0o600, flags: 'wx' });
    await new Promise((resolve, reject) => {
      output.once('error', reject); output.once('finish', resolve);
      req.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > MAX_UPLOAD_BYTES && !failed) { failed = true; req.unpipe(output); output.destroy(); resolve(); }
      });
      req.once('error', reject);
      req.pipe(output);
    });
    if (failed || !bytes) { await rm(folder, { recursive: true, force: true }); reply(res, failed ? 413 : 400, { error: failed ? 'This file is too large.' : 'This file is empty.' }); return; }
    const cleanup = setTimeout(() => { void rm(folder, { recursive: true, force: true }); }, 15 * 60_000); cleanup.unref();
    entry.finish({ canceled: false, filePaths: [filename] });
    reply(res, 200, { ok: true });
  }

  async function invoke(req, res) {
    const { op, input = {} } = await json(req, MAX_INVOKE_BYTES);
    const handler = handlers.get('local-settings');
    if (!handler || !mainWindow) { reply(res, 503, { ok: false, error: { code: 'LOCAL_OPERATION_FAILED', message: 'Companion is still starting. Try again.' } }); return; }
    const client = String(req.headers['x-companion-client'] ?? '');
    if (clients.has(client)) latestClient = client;
    const store = { client, saves: [] };
    let result;
    try { result = await context.run(store, () => handler({ sender: mainWindow.webContents, senderFrame: mainWindow.webContents.mainFrame }, op, input)); }
    catch { result = { ok: false, error: { code: 'LOCAL_OPERATION_FAILED', message: 'This action could not be completed. Reload Companion and try again.' } }; }
    if (result?.ok) for (const filename of store.saves) await context.run(store, () => offerFile(filename, { download: true }));
    reply(res, 200, result);
  }

  function stream(req, res, url) {
    const requested = url.searchParams.get('client'), id = uuid.test(requested ?? '') ? requested : randomUUID();
    res.writeHead(200, { 'Content-Type': 'text/event-stream', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write('retry: 2000\n\n');
    clients.get(id)?.end();
    clients.set(id, res); latestClient = id;
    req.on('close', () => { if (clients.get(id) === res) clients.delete(id); });
    for (const entry of dialogs.values()) write(res, 'dialog', { id: entry.id, kind: entry.kind, ...entry.details });
  }

  async function download(res, id) {
    const file = files.get(id);
    if (!file) { reply(res, 404); return; }
    let info;
    try { info = await stat(file.filename); } catch { reply(res, 404); return; }
    const type = downloads[path.extname(file.name).toLowerCase()] ?? 'application/octet-stream';
    const inline = !file.download && ['application/pdf', 'text/plain; charset=utf-8'].includes(type);
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': info.size,
      'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(file.name)}` });
    createReadStream(file.filename).on('error', () => res.destroy()).pipe(res);
  }

  async function handle(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    // Another site cannot reach this server by pointing its own name at the loopback address.
    if (req.headers.host === `localhost:${port}`) { res.writeHead(308, { Location: `${origin()}${req.url}` }); res.end(); return; }
    if (req.headers.host !== `127.0.0.1:${port}`) { reply(res, 403); return; }
    const url = new URL(req.url, origin()), route = url.pathname;
    for (const extra of routes) if (await extra(req, res, url)) return;
    const reading = req.method === 'GET' || req.method === 'HEAD';
    if (!reading && (req.method !== 'POST' || req.headers.origin !== origin())) { reply(res, 403); return; }

    if (reading && (route === '/' || route === '/index.html')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': pageSecurity });
      res.end(signedIn(req) ? await appPage() : signInPage(container
        ? `Enter the access code, or open the address this command prints in a terminal: <code>docker exec ${container} companion url</code>`
        : 'Enter the access code Companion printed when it started, or open the address it printed.'));
      return;
    }
    if (reading && !route.startsWith('/api/') && !route.startsWith('/files/')) { if (!await asset(res, route)) reply(res, 404); return; }
    if (route === '/api/session' && req.method === 'POST') {
      const supplied = (await json(req, 1024)).token;
      if (typeof supplied !== 'string' || !equal(supplied, token)) { await new Promise(resolve => setTimeout(resolve, 400)); reply(res, 401); return; }
      const expires = Date.now() + SESSION_SECONDS * 1000;
      reply(res, 200, { ok: true }, { 'Set-Cookie': `${SESSION_COOKIE}=${expires}.${sign(expires)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_SECONDS}` });
      return;
    }
    const file = /^\/files\/([A-Za-z0-9_-]{32})\/[^/]+$/.exec(route);
    if (file && reading) { await download(res, file[1]); return; }
    if (!signedIn(req)) { reply(res, 401); return; }
    if (route === '/api/events' && reading) { stream(req, res, url); return; }
    if (route === '/api/invoke' && req.method === 'POST') { await invoke(req, res); return; }
    const answer = /^\/api\/dialog\/([0-9a-f-]{36})(\/file|\/cancel)?$/.exec(route);
    if (answer && req.method === 'POST') {
      const entry = dialogs.get(answer[1]);
      if (!entry) { reply(res, 404); return; }
      if (answer[2] === '/cancel') { entry.finish(entry.fallback); reply(res, 200, { ok: true }); return; }
      if (answer[2] === '/file') { if (entry.kind !== 'open') reply(res, 400); else await upload(req, res, entry); return; }
      const { response } = await json(req, 1024);
      if (entry.kind !== 'message' || !Number.isInteger(response) || response < 0 || response >= entry.details.buttons.length) { reply(res, 400); return; }
      entry.finish({ response }); reply(res, 200, { ok: true });
      return;
    }
    reply(res, 404);
  }

  async function start() {
    await privateFolder(userData); await privateFolder(stateDirectory);
    await rm(uploads, { recursive: true, force: true });
    await privateFolder(uploads);
    const access = path.join(stateDirectory, 'access.json');
    try { token = privateJSON(access).token; } catch { token = ''; }
    if (!/^[A-Za-z0-9_-]{43}$/.test(token ?? '')) {
      token = randomBytes(32).toString('base64url');
      await writeFile(access, JSON.stringify({ token }), { mode: 0o600 });
      protectPrivatePath(access);
    }
    server = createServer((req, res) => {
      handle(req, res).catch(error => { if (res.headersSent) res.destroy(); else reply(res, error.status ?? 500); });
    });
    server.requestTimeout = 10 * 60_000; server.headersTimeout = 10_000;
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, bind, resolve); });
    port = server.address().port;
    heartbeat = setInterval(() => { for (const client of clients.values()) client.write(': keep-alive\n\n'); }, 25_000); heartbeat.unref();
    for (const signal of ['SIGTERM', 'SIGINT']) signals.once(signal, () => app.quit());
    ready = true;
    log(`Recruiters.rip Companion is running. Open ${webHost.accessUrl()}`);
  }
  async function close() {
    clearInterval(heartbeat);
    for (const entry of [...dialogs.values()]) entry.finish(entry.fallback);
    for (const file of files.values()) clearTimeout(file.timer);
    files.clear();
    for (const client of clients.values()) client.end();
    clients.clear();
    if (server?.listening) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  }

  const webHost = {
    get origin() { return origin(); },
    get port() { return port; },
    container,
    accessUrl: () => `${origin()}/#access=${token}`,
    /** Serve an extra path, such as the account-connection return page. The handler returns true when it answered. */
    route(handler) { routes.add(handler); return () => routes.delete(handler); },
    /** An address the browser extension can open for a local file. */
    fileUrl: async (filename, options) => `${origin()}${(await shareFile(filename, options)).path}`,
    offerFile, close,
  };

  return {
    app, shell, clipboard, dialog, webHost, BrowserWindow: WebWindow,
    ipcMain: { handle(channel, handler) { handlers.set(channel, handler); } },
    powerMonitor: { on() {} },
    Menu: { setApplicationMenu() {}, buildFromTemplate: template => template },
    safeStorage: { isEncryptionAvailable: () => false, decryptString() { throw new Error('The system keychain is unavailable in the web shell.'); } },
  };
}

export const { app, BrowserWindow, ipcMain, powerMonitor, Menu, shell, clipboard, dialog, safeStorage, webHost } = createWebShell();
