import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { request as httpRequest } from 'node:http';
import { createWebShell } from '../src/web-shell.mjs';
import { startPairingReturn } from '../src/pairing-return.mjs';

// A started web shell with a stand-in for the main process: `operations[op]` answers the settings bridge.
async function harness(t, { data, operations = {} } = {}) {
  const directory = data ?? await mkdtemp(path.join(tmpdir(), 'recruiters-web-shell-'));
  if (!data) t.after(() => rm(directory, { recursive: true, force: true }));
  const exits = [], logs = [];
  const api = createWebShell({ argv: ['node', 'main.mjs', `--user-data-dir=${directory}`], env: { RECRUITERS_COMPANION_WEB_PORT: '0' },
    exit: code => exits.push(code), log: line => logs.push(line), signals: new EventEmitter() });
  const window = new api.BrowserWindow();
  await window.loadURL('file:///ui/index.html');
  api.ipcMain.handle('local-settings', async (event, op, input) => {
    assert.equal(event.sender, window.webContents);
    assert.equal(event.senderFrame.url, 'file:///ui/index.html');
    if (!operations[op]) return { ok: false, error: { code: 'INVALID_INPUT', message: 'Unknown.' } };
    return { ok: true, result: await operations[op](input) };
  });
  await api.app.whenReady();
  t.after(() => api.webHost.close());
  const origin = api.webHost.origin, token = new URL(api.webHost.accessUrl()).hash.slice('#access='.length);
  const request = (route, { cookie, body, headers = {}, method = body === undefined ? 'GET' : 'POST' } = {}) => fetch(`${origin}${route}`, { method, redirect: 'manual',
    headers: { ...(method === 'POST' ? { Origin: origin } : {}), ...(cookie ? { Cookie: cookie } : {}), ...(body !== undefined && !headers['Content-Type'] ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body === undefined ? undefined : typeof body === 'string' || body instanceof Uint8Array ? body : JSON.stringify(body) });
  async function signIn() {
    const response = await request('/api/session', { body: { token } });
    assert.equal(response.status, 200);
    return response.headers.get('set-cookie').split(';')[0];
  }
  // The browser tab's event stream, as parsed `{ event, data }` records.
  async function tab(cookie, client = crypto.randomUUID()) {
    const controller = new AbortController();
    t.after(() => controller.abort());
    const response = await fetch(`${origin}/api/events?client=${client}`, { headers: { Cookie: cookie }, signal: controller.signal });
    assert.equal(response.status, 200);
    const reader = response.body.getReader(), decoder = new TextDecoder(), queue = [];
    let buffer = '', waiting;
    void (async () => {
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) return;
          buffer += decoder.decode(value, { stream: true });
          for (let end = buffer.indexOf('\n\n'); end >= 0; end = buffer.indexOf('\n\n')) {
            const block = buffer.slice(0, end); buffer = buffer.slice(end + 2);
            const event = /^event: (.+)$/m.exec(block)?.[1], data = /^data: (.+)$/m.exec(block)?.[1];
            if (event) { queue.push({ event, data: JSON.parse(data) }); waiting?.(); }
          }
        }
      } catch { /* The test closed the stream. */ }
    })();
    const next = async name => {
      for (;;) {
        const index = queue.findIndex(entry => entry.event === name);
        if (index >= 0) return queue.splice(index, 1)[0].data;
        await new Promise(resolve => { waiting = resolve; });
      }
    };
    const invoke = (op, input = {}) => request('/api/invoke', { cookie, body: { op, input }, headers: { 'X-Companion-Client': client } }).then(response => response.json());
    return { client, next, invoke, close: () => controller.abort() };
  }
  return { api, directory, origin, token, request, signIn, tab, exits, logs };
}

test('the screens are reachable only at the loopback address, with the access code, from the page itself', { timeout: 10000 }, async t => {
  const seen = [];
  const f = await harness(t, { operations: { state: input => { seen.push(input); return { paired: false }; } } });
  assert.match(f.logs[0], /Open http:\/\/127\.0\.0\.1:\d+\/#access=[A-Za-z0-9_-]{43}$/);
  assert.equal((await f.request('/api/invoke', { body: { op: 'state' } })).status, 401);
  assert.equal((await f.request('/api/events')).status, 401);
  assert.equal((await f.request('/api/session', { body: { token: 'A'.repeat(43) } })).status, 401);
  const landing = await f.request('/');
  assert.match(await landing.text(), /id="signin"/, 'Without the access code the page offers only the sign-in form');
  const cookie = await f.signIn();
  const page = await (await f.request('/', { cookie })).text();
  assert.ok(page.includes('<script src="web-shell.js"></script>') && page.includes("connect-src 'self'") && !page.includes("connect-src 'none'"),
    'The signed-in page carries the browser bridge and may talk to this origin only');
  assert.deepEqual(await (await f.request('/api/invoke', { cookie, body: { op: 'state', input: { a: 1 } } })).json(), { ok: true, result: { paired: false } });
  assert.deepEqual(seen, [{ a: 1 }]);
  // Another site that reaches this port (its own name pointed at loopback, or a cross-site request) is refused.
  assert.equal((await f.request('/api/invoke', { cookie, body: { op: 'state' }, headers: { Origin: 'https://attacker.example' } })).status, 403);
  const port = new URL(f.origin).port;
  const rebound = await new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path: '/', headers: { Host: `attacker.example:${port}`, Cookie: cookie } }, res => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject); req.end();
  });
  assert.equal(rebound, 403);
  assert.equal(seen.length, 1);
});

test('a browser stays signed in when Companion restarts, and a changed access code signs it out', { timeout: 10000 }, async t => {
  const first = await harness(t, { operations: { state: () => ({}) } });
  const cookie = await first.signIn();
  await first.api.webHost.close();
  const second = await harness(t, { data: first.directory, operations: { state: () => ({}) } });
  assert.equal(second.token, first.token);
  assert.equal((await second.request('/api/invoke', { cookie, body: { op: 'state' } })).status, 200);
  const [expires, signature] = cookie.split('=')[1].split('.');
  assert.equal((await second.request('/api/invoke', { cookie: `rr_companion=${Number(expires) + 1}.${signature}`, body: { op: 'state' } })).status, 401);
  await second.api.webHost.close();
  await writeFile(path.join(first.directory, 'web-shell', 'access.json'), JSON.stringify({ token: 'B'.repeat(43) }), { mode: 0o600 });
  const third = await harness(t, { data: first.directory, operations: { state: () => ({}) } });
  assert.equal((await third.request('/api/invoke', { cookie, body: { op: 'state' } })).status, 401);
});

test('choosing a file uploads it from the browser; unsupported, oversized-name and cancelled choices never reach the app', { timeout: 10000 }, async t => {
  let f;
  f = await harness(t, { operations: {
    'import-cv': async () => {
      const chosen = await f.api.dialog.showOpenDialog(null, { title: 'Choose your source CV', filters: [{ name: 'CV documents', extensions: ['pdf', 'txt'] }] });
      return chosen.canceled ? { cancelled: true } : { name: path.basename(chosen.filePaths[0]), text: await readFile(chosen.filePaths[0], 'utf8') };
    },
  } });
  const cookie = await f.signIn(), page = await f.tab(cookie);
  const upload = (id, name, body) => f.request(`/api/dialog/${id}/file`, { cookie, body, headers: { 'Content-Type': 'application/octet-stream', 'X-File-Name': encodeURIComponent(name) } });

  let result = page.invoke('import-cv');
  let dialog = await page.next('dialog');
  assert.deepEqual({ kind: dialog.kind, title: dialog.title, extensions: dialog.extensions }, { kind: 'open', title: 'Choose your source CV', extensions: ['pdf', 'txt'] });
  assert.equal((await upload(dialog.id, 'malware.exe', 'x')).status, 400);
  assert.equal((await upload(dialog.id, '../../escape.txt', 'Synthetic CV text')).status, 200);
  assert.deepEqual(await result, { ok: true, result: { name: 'escape.txt', text: 'Synthetic CV text' } });
  assert.equal((await upload(dialog.id, 'again.txt', 'x')).status, 404, 'An answered request cannot be answered twice');

  result = page.invoke('import-cv');
  dialog = await page.next('dialog');
  assert.equal((await f.request(`/api/dialog/${dialog.id}/file`, { body: 'x', headers: { 'Content-Type': 'application/octet-stream', 'X-File-Name': 'cv.txt' } })).status, 401);
  assert.equal((await f.request(`/api/dialog/${dialog.id}/cancel`, { cookie, method: 'POST' })).status, 200);
  assert.deepEqual(await result, { ok: true, result: { cancelled: true } });
});

test('a confirmation is answered in the page, and closing it means the cancel button', { timeout: 10000 }, async t => {
  let f;
  f = await harness(t, { operations: { 'cv-delete': async () => f.api.dialog.showMessageBox(null, { type: 'warning', buttons: ['Cancel', 'Delete CV'], defaultId: 0, cancelId: 0, message: 'Delete this CV?' }) } });
  const cookie = await f.signIn(), page = await f.tab(cookie);
  let result = page.invoke('cv-delete');
  let dialog = await page.next('dialog');
  assert.deepEqual({ kind: dialog.kind, type: dialog.type, message: dialog.message, buttons: dialog.buttons }, { kind: 'message', type: 'warning', message: 'Delete this CV?', buttons: ['Cancel', 'Delete CV'] });
  assert.equal((await f.request(`/api/dialog/${dialog.id}`, { cookie, body: { response: 2 } })).status, 400);
  assert.equal((await f.request(`/api/dialog/${dialog.id}`, { cookie, body: { response: 1 } })).status, 200);
  assert.deepEqual(await result, { ok: true, result: { response: 1 } });
  result = page.invoke('cv-delete');
  dialog = await page.next('dialog');
  assert.equal((await f.request(`/api/dialog/${dialog.id}/cancel`, { cookie, method: 'POST' })).status, 200);
  assert.deepEqual(await result, { ok: true, result: { response: 0 } });
});

test('saved and opened files reach the browser as short-lived links; links, text and folders go to the tab that asked', { timeout: 10000 }, async t => {
  let f;
  f = await harness(t, { operations: {
    backup: async () => {
      const chosen = await f.api.dialog.showSaveDialog(null, { defaultPath: path.join(f.directory, 'recruiters-backup.json') });
      await writeFile(chosen.filePath, '{"synthetic":true}');
      return { exported: true };
    },
    document: async () => ({ error: await f.api.shell.openPath(path.join(f.directory, 'letter.pdf')) }),
    folder: async () => ({ error: await f.api.shell.openPath(f.directory) }),
    link: async () => { await f.api.shell.openExternal('https://recruiters.rip/account'); return {}; },
    copy: async () => { f.api.clipboard.writeText('synthetic prompt'); return {}; },
  } });
  await writeFile(path.join(f.directory, 'letter.pdf'), '%PDF-synthetic');
  const cookie = await f.signIn(), page = await f.tab(cookie), other = await f.tab(cookie);

  assert.deepEqual(await page.invoke('backup'), { ok: true, result: { exported: true } });
  const saved = await page.next('open-file');
  assert.deepEqual({ name: saved.name, download: saved.download }, { name: 'recruiters-backup.json', download: true });
  // The link is its own key: the browser extension may open it from a browser that never signed in.
  const download = await f.request(saved.url);
  assert.equal(download.headers.get('content-disposition'), "attachment; filename*=UTF-8''recruiters-backup.json");
  assert.equal(await download.text(), '{"synthetic":true}');

  assert.deepEqual(await page.invoke('document'), { ok: true, result: { error: '' } });
  const opened = await page.next('open-file');
  const shown = await f.request(opened.url);
  assert.equal(shown.headers.get('content-type'), 'application/pdf');
  assert.match(shown.headers.get('content-disposition'), /^inline;/);
  assert.equal((await f.request(opened.url.replace(/\/files\/.{4}/, '/files/AAAA'))).status, 404);

  assert.notEqual((await page.invoke('folder')).result.error, '', 'A folder cannot be opened from a browser, and the app is told so');
  await page.invoke('link'); await page.invoke('copy');
  assert.deepEqual(await page.next('open-link'), { url: 'https://recruiters.rip/account' });
  assert.deepEqual(await page.next('copy-text'), { text: 'synthetic prompt' });
  // The other tab asked for none of this.
  await other.invoke('copy');
  assert.deepEqual(await other.next('copy-text'), { text: 'synthetic prompt' });
  assert.equal(await Promise.race([other.next('open-link'), new Promise(resolve => setTimeout(() => resolve('none'), 150))]), 'none');

  // With no tab open there is nowhere to open a link, and the caller hears about it.
  page.close(); other.close();
  await new Promise(resolve => setTimeout(resolve, 100));
  await assert.rejects(f.api.shell.openExternal('https://recruiters.rip/account'), /Open Companion in your browser/);
  assert.equal(await f.api.webHost.fileUrl(path.join(f.directory, 'letter.pdf')).then(url => fetch(url)).then(response => response.status), 200);
});

test('state changes reach every open tab, and quitting waits for the app to finish saving', { timeout: 10000 }, async t => {
  const f = await harness(t);
  const cookie = await f.signIn(), one = await f.tab(cookie), two = await f.tab(cookie);
  const window = new f.api.BrowserWindow();
  window.webContents.send('state-changed');
  window.webContents.send('settings-section', 'decisions');
  for (const page of [one, two]) {
    assert.deepEqual(await page.next('state-changed'), {});
    assert.equal(await page.next('settings-section'), 'decisions');
  }
  let saving = true;
  f.api.app.on('before-quit', event => { event.preventDefault(); setTimeout(() => { saving = false; f.api.app.exit(0); }, 50); });
  f.api.app.quit();
  assert.deepEqual(f.exits, [], 'The process must not exit while the app is still saving');
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.equal(saving, false);
  assert.deepEqual(f.exits, [0]);
});

test('the account-connection return is served on the web shell’s own port and removed when it closes', { timeout: 10000 }, async t => {
  const f = await harness(t);
  const pairs = [];
  const connection = await startPairingReturn({ host: f.api.webHost, onPair: async payload => { pairs.push(payload); } });
  assert.equal(connection.companionReturn, `${f.origin}/pair`);
  const landing = await fetch(connection.companionReturn);
  assert.equal(landing.status, 200, 'The return page needs no Companion sign-in: the website sends the browser straight to it');
  assert.match(await landing.text(), /Account connection/);
  const post = (state, origin = f.origin) => fetch(connection.companionReturn, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ state, payload: Buffer.from(JSON.stringify({ synthetic: true })).toString('base64url') }) });
  assert.equal((await post(connection.companionState, 'https://attacker.example')).status, 403);
  assert.equal((await post('A'.repeat(43))).status, 403);
  assert.equal((await post(connection.companionState)).status, 200);
  assert.deepEqual(pairs, [{ synthetic: true }]);
  connection.close();
  assert.equal((await fetch(connection.companionReturn)).status, 404);
});
