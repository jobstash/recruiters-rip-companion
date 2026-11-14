import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { renameSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { request as httpRequest } from 'node:http';
import { createHash } from 'node:crypto';
import { createWebShell } from '../src/web-shell.mjs';
import { startPairingReturn } from '../src/pairing-return.mjs';
import { createVault } from '../src/vault.mjs';
import { hash } from '../src/mcp/state.mjs';
import { applicationContextFingerprint, currentApplicationExport } from '../src/application-workflow.mjs';
import { readyMaster } from './helpers/ready-master.mjs';

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
  let activeClient;
  const request = (route, { cookie, body, headers = {}, signal, method = body === undefined ? 'GET' : 'POST' } = {}) => fetch(`${origin}${route}`, { method, redirect: 'manual', signal,
    headers: { ...(method === 'POST' ? { Origin: origin } : {}), ...(cookie ? { Cookie: cookie } : {}),
      ...(activeClient && /^\/(?:files\/|api\/(?:dialog|downloads)\/)/.test(route) ? { 'X-Companion-Client': activeClient } : {}),
      ...(body !== undefined && !headers['Content-Type'] ? { 'Content-Type': 'application/json' } : {}), ...headers },
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
    activeClient = client;
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
  // Backups are private to the browser session that requested them.
  assert.equal((await f.request(saved.url)).status, 401);
  const download = await f.request(saved.url, { cookie });
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

test('master bytes download only while the captured browser session and ready snapshot remain current', { timeout: 10000 }, async t => {
  let f, current = true;
  const bytes = Buffer.from('Synthetic master CV\n');
  f = await harness(t, { operations: {
    'master-cv-export': async () => {
      await f.api.webHost.publishDownload(bytes, { name: 'Master CV.txt',
        assertCurrent: () => { if (!current) throw Object.assign(new Error('Changed'), { code: 'REVISION_CONFLICT' }); } });
      return { exported: true, filename: 'Master CV.txt' };
    },
  } });
  const cookie = await f.signIn(), page = await f.tab(cookie);
  let settled = false;
  const exporting = page.invoke('master-cv-export').then(result => { settled = true; return result; });
  const download = await page.next('open-file');
  assert.equal(download.download, true);
  assert.equal(settled, false, 'An SSE offer is not a completed export');
  assert.equal((await f.request(`/api/downloads/${download.receipt}`, { cookie, body: { received: true } })).status, 409, 'Acknowledgement without receiving bytes is insufficient');
  assert.equal((await f.request(download.url)).status, 401, 'Master downloads require a signed-in browser, not just a leaked link');
  const response = await f.request(download.url, { cookie });
  assert.equal(response.status, 200);
  assert.equal(await response.text(), bytes.toString());
  assert.match(response.headers.get('content-disposition'), /^attachment;/);
  assert.equal(settled, false, 'Server delivery still waits for the browser to consume the response');
  await f.request(`/api/downloads/${download.receipt}`, { cookie, body: { received: true } });
  assert.deepEqual(await exporting, { ok: true, result: { exported: true, filename: 'Master CV.txt' } });
  const staleExport = page.invoke('master-cv-export');
  const stale = await page.next('open-file');
  current = false;
  assert.equal((await f.request(stale.url, { cookie })).status, 409, 'An issued link cannot outlive its ready master');
  assert.equal((await staleExport).ok, false);
  assert.equal((await f.request(stale.url, { cookie })).status, 404);
});

test('master download confirmation cancellation publishes no bytes and no browserless success', { timeout: 10000 }, async t => {
  let f, published = 0;
  f = await harness(t, { operations: {
    'master-cv-export': async () => {
      const assertAccess = f.api.webHost.captureAccess();
      assertAccess();
      const choice = await f.api.dialog.showMessageBox(null, { message: 'Download Master CV.pdf?', buttons: ['Cancel', 'Download'], cancelId: 0 });
      assertAccess();
      if (choice.response !== 1) return { exported: false };
      await f.api.webHost.publishDownload(Buffer.from('%PDF-synthetic'), { name: 'Master CV.pdf', assertCurrent: assertAccess });
      published++;
      return { exported: true, filename: 'Master CV.pdf' };
    },
  } });
  const cookie = await f.signIn();
  const noTab = await f.request('/api/invoke', { cookie, body: { op: 'master-cv-export' } });
  assert.equal((await noTab.json()).ok, false);
  const page = await f.tab(cookie), exporting = page.invoke('master-cv-export');
  const dialog = await page.next('dialog');
  await f.request(`/api/dialog/${dialog.id}/cancel`, { cookie, method: 'POST' });
  assert.deepEqual(await exporting, { ok: true, result: { exported: false } });
  assert.equal(published, 0);
});

test('file-backed application offers recheck source, master, draft and identity while retaining native cross-browser access', { timeout: 10000 }, async t => {
  const f = await harness(t);
  const store = createVault(path.join(f.directory, 'synthetic-vault')); await store.open();
  await readyMaster(store);
  const filename = path.join(f.directory, 'Application.pdf'), bytes = Buffer.from('%PDF-synthetic-current-application');
  await writeFile(filename, bytes);
  const applicationId = crypto.randomUUID();
  await store.update(state => {
    const career = state.career, version = career.masterCv.current.version;
    const app = { id: applicationId, job: { id: 'synthetic-job', title: 'Engineer', company: 'Synthetic Employer', description: 'Build reliable services.', complete: true },
      cv: { version: 1, masterVersion: version }, coverLetter: null, exports: [] };
    career.applications[applicationId] = app;
    app.cv.contextFingerprint = applicationContextFingerprint(career, app);
    app.exports.push({ uri: `recruiters://documents/${crypto.randomUUID()}.pdf`, applicationId, kind: 'cv', format: 'pdf',
      sha256: createHash('sha256').update(bytes).digest('hex'), documentVersion: 1, masterVersion: version,
      contextFingerprint: app.cv.contextFingerprint, textValidation: { passed: true } });
  });
  const baseline = store.get().career;
  let epoch = 0;
  for (const change of ['source', 'master', 'draft', 'identity', 'bytes']) {
    await store.update(state => { state.career = structuredClone(baseline); });
    await writeFile(filename, bytes);
    const expected = currentApplicationExport(store.get().career, store.get().career.applications[applicationId], 'cv'), generation = epoch;
    const url = await f.api.webHost.fileUrl(filename, { sha256: expected.sha256, assertCurrent: () => {
      const career = store.get().career;
      if (generation !== epoch || hash(currentApplicationExport(career, career.applications[applicationId], 'cv')) !== hash(expected)) throw new Error('Stale application');
    } });
    assert.equal((await fetch(url)).status, 200, 'Native-extension capability links work in a browser that has not signed in');
    if (change === 'identity') epoch++;
    else if (change === 'bytes') await writeFile(filename, '%PDF-other-application');
    else await store.update(state => {
      if (change === 'source') Object.values(state.career.sources)[0].text += '\nNew source evidence';
      else if (change === 'master') state.career.masterCv.current.version++;
      else state.career.applications[applicationId].cv.version++;
    });
    const stale = await fetch(url);
    assert.equal(stale.status, 409, change);
    assert.equal((await stale.text()).includes('%PDF-'), false);
  }
});

test('file offers recheck after reading bytes and private backup links survive reconnect but not identity changes', { timeout: 10000 }, async t => {
  let f, epoch = 0;
  f = await harness(t, { operations: { backup: async () => {
    const generation = epoch;
    const selected = await f.api.dialog.showSaveDialog(null, { defaultPath: path.join(f.directory, 'private-backup.json'),
      assertCurrent: () => { if (generation !== epoch) throw new Error('Profile restored'); } });
    await writeFile(selected.filePath, '{"synthetic":true}');
    return { exported: true };
  } } });
  const cookie = await f.signIn(), page = await f.tab(cookie);
  await page.invoke('backup');
  const first = await page.next('open-file');
  assert.equal((await f.request(first.url, { cookie })).status, 200);
  epoch++;
  assert.equal((await f.request(first.url, { cookie })).status, 409);
  await page.invoke('backup');
  const second = await page.next('open-file');
  await f.tab(cookie, page.client);
  assert.equal((await f.request(second.url, { cookie })).status, 200, 'A same-client authenticated reconnect retains the session');
  const otherCookie = await f.signIn();
  assert.equal((await f.request(second.url, { cookie: otherCookie })).status, 401, 'Another authorized session cannot consume a private backup');
  let checks = 0, downloading = false;
  const file = path.join(f.directory, 'guarded.pdf'); await writeFile(file, '%PDF-synthetic');
  const url = await f.api.webHost.fileUrl(file, { assertCurrent: () => {
    if (downloading && ++checks === 3) throw new Error('Changed during async read');
  } });
  downloading = true;
  const response = await fetch(url);
  assert.equal(response.status, 409);
  assert.equal((await response.text()).includes('%PDF-'), false);
  assert.equal(checks, 3);
});

test('file delivery reads the validated descriptor when the pathname is replaced', async t => {
  const f = await harness(t);
  const file = path.join(f.directory, 'selected.pdf'), original = '%PDF-original-reviewed';
  await writeFile(file, original);
  let downloading = false, checks = 0;
  const url = await f.api.webHost.fileUrl(file, { assertCurrent: () => {
    if (downloading && ++checks === 2) {
      renameSync(file, `${file}.old`);
      writeFileSync(file, '%PDF-replacement-not-reviewed');
    }
  } });
  downloading = true;
  const response = await fetch(url);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), original);
  assert.equal(await readFile(file, 'utf8'), '%PDF-replacement-not-reviewed');
});

test('master delivery survives same-client SSE reconnect and new-page exports without crossing browser sessions', { timeout: 10000 }, async t => {
  let f;
  f = await harness(t, { operations: { 'master-cv-export': async () => {
    await f.api.webHost.publishDownload(Buffer.from('%PDF-synthetic'), { name: 'Master CV.pdf', assertCurrent: () => {} });
    return { exported: true };
  } } });
  const cookie = await f.signIn(), page = await f.tab(cookie);
  const pending = page.invoke('master-cv-export'), offer = await page.next('open-file');
  const reconnected = await f.tab(cookie, page.client);
  assert.equal((await reconnected.next('open-file')).receipt, offer.receipt);
  const newPage = await f.tab(cookie);
  assert.equal((await f.request(offer.url, { cookie, headers: { 'X-Companion-Client': newPage.client } })).status, 403);
  const otherCookie = await f.signIn();
  assert.equal((await f.request(`/api/events?client=${page.client}`, { cookie: otherCookie })).status, 403);
  assert.equal((await f.request(offer.url, { cookie: otherCookie, headers: { 'X-Companion-Client': page.client } })).status, 403);
  const bytes = await f.request(offer.url, { cookie, headers: { 'X-Companion-Client': page.client } });
  assert.equal(await bytes.text(), '%PDF-synthetic');
  await f.request(`/api/downloads/${offer.receipt}`, { cookie, headers: { 'X-Companion-Client': page.client }, body: { received: true } });
  assert.deepEqual(await pending, { ok: true, result: { exported: true } });
  // Completing an ordinary HTTP request must not close the SSE session.
  const next = newPage.invoke('master-cv-export'), fresh = await newPage.next('open-file');
  assert.equal(await (await f.request(fresh.url, { cookie, headers: { 'X-Companion-Client': newPage.client } })).text(), '%PDF-synthetic');
  await f.request(`/api/downloads/${fresh.receipt}`, { cookie, headers: { 'X-Companion-Client': newPage.client }, body: { received: true } });
  assert.deepEqual(await next, { ok: true, result: { exported: true } });
});

test('failed browser consumption and an aborted invoke never report exported or retain pending bytes', { timeout: 10000 }, async t => {
  let f, interrupted;
  const finished = new Promise(resolve => { interrupted = resolve; });
  f = await harness(t, { operations: { 'master-cv-export': async () => {
    try { await f.api.webHost.publishDownload(Buffer.from('%PDF-synthetic'), { name: 'Master CV.pdf', assertCurrent: () => {} }); }
    catch (error) { interrupted(); throw error; }
    return { exported: true };
  } } });
  const cookie = await f.signIn(), page = await f.tab(cookie), pending = page.invoke('master-cv-export');
  const failed = await page.next('open-file');
  await f.request(`/api/downloads/${failed.receipt}`, { cookie, body: { received: false } });
  assert.equal((await pending).ok, false);
  assert.equal((await f.request(failed.url, { cookie })).status, 404);
  const controller = new AbortController();
  let disconnected;
  const abandoned = new Promise(resolve => { disconnected = resolve; });
  interrupted = disconnected;
  const request = f.request('/api/invoke', { cookie, body: { op: 'master-cv-export' }, headers: { 'X-Companion-Client': page.client }, signal: controller.signal });
  const offered = await page.next('open-file');
  controller.abort();
  await assert.rejects(request, { name: 'AbortError' });
  await abandoned;
  assert.equal((await f.request(offered.url, { cookie })).status, 404);
  await finished;
});
