import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { BROWSER_IDENTITIES } from '../src/browser-identity.mjs';
import { createManifest } from '../browser-extension/manifest.mjs';
import { safeDeviceRequest, externalSenderAllowed, deviceResult, createNativeClient, safeNativeCommand, applicationView, reviewIdentity } from '../browser-extension/src/protocol.mjs';
import { captureJobs, captureApplicationContext, inspectForm, checkFormBindings, armSmartPaste, disarmSmartPaste } from '../browser-extension/src/page.mjs';
import { createPageAccess, preparedPageSender } from '../browser-extension/src/page-access.mjs';
import { installManagedUpdates } from '../browser-extension/src/managed-update.mjs';

const origin = BROWSER_IDENTITIES.production.productOrigin;
const request = (op, payload = {}) => ({ version: 1, id: randomUUID(), op, payload });
const event = () => { const listeners = []; return { addListener(fn) { listeners.push(fn); }, emit(...values) { for (const fn of listeners) fn(...values); } }; };
const fakePort = () => ({ onMessage: event(), onDisconnect: event(), sent: [], postMessage(message) { this.sent.push(message); }, disconnect() { this.onDisconnect.emit(); } });
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

test('page access relies on Chrome permission enforcement and retains document identity on inspection', async () => {
  let denied = true;
  const calls = [], tab = { id: 7 };
  const inject = createPageAccess({
    sidePanel: { setPanelBehavior: async () => {} },
    tabs: { async get() { return tab; } },
    scripting: { async executeScript(options) { calls.push(options); if (denied) throw new Error('Missing host permission'); return [{ result: { fields: [], actions: [] }, documentId: 'snapshot-document' }]; } },
    onError: error => { throw error; },
  });
  await assert.rejects(inject(7, inspectForm), { code: 'PAGE_PERMISSION_REQUIRED' });
  denied = false;
  await inject(7, inspectForm, [], 'snapshot-document');
  assert.deepEqual(calls.at(-1).target, { tabId: 7, documentIds: ['snapshot-document'] });
  tab.url = 'chrome://extensions';
  await assert.rejects(inject(7, captureJobs), { code: 'PAGE_UNSUPPORTED' });
  assert.equal(calls.length, 2);
});

test('toolbar invocation opens the panel in its gesture and reads the granted tab, not a previous tab', async () => {
  let granted = false;
  const onClicked = event(), opened = [], inspected = [];
  const inject = createPageAccess({
    sidePanel: { setPanelBehavior: async () => {}, open: async ({ tabId }) => { opened.push(tabId); } },
    action: { onClicked },
    tabs: { get: async id => ({ id }) },
    scripting: { executeScript: async ({ target }) => {
      if (!granted) throw new Error('Cannot access contents of the page.');
      inspected.push(target.tabId);
      return [{ result: { fields: [] }, documentId: 'doc' }];
    } },
    onAccess: tabId => inject(tabId, inspectForm),
    onError: assert.fail,
  });
  await assert.rejects(inject(7, inspectForm));
  assert.deepEqual(inspected, []);
  granted = true; // Chrome grants activeTab before dispatching action.onClicked.
  onClicked.emit({ id: 9 });
  assert.deepEqual(opened, [9]); // Native panel open occurs synchronously in the gesture.
  await tick();
  assert.deepEqual(inspected, [9]);
  onClicked.emit({});
  await tick();
  assert.deepEqual(opened, [9]);
});

test('production and local identities derive distinct IDs and minimal user-triggered permissions', () => {
  for (const [mode, identity] of Object.entries(BROWSER_IDENTITIES)) {
    const derived = [...createHash('sha256').update(Buffer.from(identity.key, 'base64')).digest('hex').slice(0, 32)].map(c => String.fromCharCode(97 + parseInt(c, 16))).join('');
    assert.equal(derived, identity.extensionId);
    const manifest = createManifest(identity, '3.8.1', mode === 'local');
    assert.deepEqual(manifest.permissions, ['nativeMessaging','activeTab','scripting','sidePanel','clipboardWrite','alarms','idle','storage']);
    assert.equal(manifest.host_permissions, undefined);
    assert.equal(manifest.content_scripts, undefined);
    assert.equal(manifest.action.default_popup, undefined);
    assert.equal(manifest.side_panel.default_path, 'panel.html');
    assert.deepEqual(manifest.externally_connectable.matches, [`${identity.productOrigin}/*`]);
  }
  assert.notEqual(BROWSER_IDENTITIES.local.extensionId, BROWSER_IDENTITIES.production.extensionId);
  assert.notEqual(BROWSER_IDENTITIES.local.nativeHost, BROWSER_IDENTITIES.production.nativeHost);
});

test('Firefox builds have isolated Gecko identities and only supported sidebar/background permissions', () => {
  const ids = [];
  for (const [mode, identity] of Object.entries(BROWSER_IDENTITIES)) {
    const manifest = createManifest(identity, '3.8.1', mode === 'local', 'firefox');
    ids.push(manifest.browser_specific_settings.gecko.id);
    assert.equal(manifest.browser_specific_settings.gecko.id, identity.firefoxExtensionId);
    assert.equal(manifest.browser_specific_settings.gecko.strict_min_version, '128.0');
    assert.deepEqual(manifest.background, { scripts: ['background.mjs'], type: 'module' });
    assert.equal(manifest.sidebar_action.default_panel, 'panel.html');
    assert.deepEqual(manifest.permissions, ['nativeMessaging', 'activeTab', 'scripting', 'clipboardWrite', 'alarms', 'idle', 'storage']);
    for (const key of ['key', 'side_panel', 'externally_connectable', 'minimum_chrome_version', 'host_permissions', 'content_scripts'])
      assert.equal(manifest[key], undefined, key);
    assert.equal(manifest.action.default_popup, undefined);
    assert.deepEqual(manifest.browser_specific_settings.gecko.data_collection_permissions.required, ['websiteContent', 'personallyIdentifyingInfo']);
  }
  assert.deepEqual(ids, ['recruiters-rip@recruiters.rip', 'recruiters-rip-local@recruiters.rip']);
  assert.throws(() => createManifest(BROWSER_IDENTITIES.production, '3.8.1', false, 'unknown'));
});

test('Firefox sidebar opens inside the toolbar gesture before any inspection awaits', async () => {
  const onClicked = event(), calls = [];
  let gesture = false;
  createPageAccess({
    sidebarAction: { open() { assert.equal(gesture, true); calls.push('open'); return Promise.resolve(); } },
    action: { onClicked }, tabs: {}, scripting: {},
    onAccess: tabId => { assert.equal(gesture, false); calls.push(tabId); },
    onError: assert.fail,
  });
  gesture = true;
  onClicked.emit({ id: 42 });
  assert.deepEqual(calls, ['open']);
  gesture = false;
  await tick();
  assert.deepEqual(calls, ['open', 42]);
});

test('Firefox document tokens guard the same injection without falling back to a navigated frame', async () => {
  let page = pastePage();
  const calls = [];
  const inject = createPageAccess({
    sidebarAction: {}, tabs: { get: async id => ({ id, url: page.context.location.href }) },
    scripting: { executeScript: async options => {
      calls.push(options);
      try { return [{ frameId: 0, result: await page.invoke(options.func, ...options.args) }]; }
      catch (error) { return [{ frameId: 0, error }]; }
    } },
  });
  const first = await inject(7, inspectForm);
  assert.ok(first.documentId);
  assert.equal(first.page.documentToken, undefined, 'opaque token is not sent to native form schemas');
  const request = { url: first.page.url, fields: first.page.fields, actions: first.page.actions };
  assert.equal((await inject(7, checkFormBindings, [request], first.documentId)).page.attached, true);
  assert.deepEqual(calls.at(-1).target, { tabId: 7, frameIds: [0] });
  page = pastePage(); // Same URL and control labels; entirely new document.
  for (const [func, args] of [[checkFormBindings, [request]], [captureJobs, []], [captureApplicationContext, []], [armSmartPaste, [{ session: randomUUID() }]], [disarmSmartPaste, []]])
    await assert.rejects(inject(7, func, args, first.documentId), /page changed/);
  assert.deepEqual(page.messages, []);
  assert.deepEqual(page.clipboard, []);
  const next = await inject(7, inspectForm);
  assert.notEqual(next.documentId, first.documentId);
});

test('clipboard senders require the actual browser document binding, top frame and inspected tab', () => {
  const state = { tabId: 7, documentId: 'document-token' };
  const sender = { tab: { id: 7 }, frameId: 0 }, message = { documentToken: 'document-token' };
  assert.equal(preparedPageSender(sender, message, state, true), true);
  assert.equal(preparedPageSender(sender, message, state), false, 'Chrome must never fall back to an extension token');
  for (const invalid of [{ ...sender, frameId: 1 }, { ...sender, tab: { id: 8 } }])
    assert.equal(preparedPageSender(invalid, message, state, true), false);
  assert.equal(preparedPageSender(sender, { documentToken: 'previous-document' }, state, true), false);
  assert.equal(preparedPageSender(sender, {}, state, true), false);
  assert.equal(preparedPageSender({ ...sender, documentId: state.documentId }, {}, state), true);
});

test('Firefox native ports retain channel host identity and fail pending requests on disconnect', async () => {
  for (const identity of Object.values(BROWSER_IDENTITIES)) {
    const port = fakePort(), hosts = [];
    const browser = { runtime: { connectNative(host) { hosts.push(host); return port; } } };
    const client = createNativeClient({ host: identity.nativeHost, connect: host => browser.runtime.connectNative(host) });
    const response = client.request('application_resolve', { requestId: randomUUID() });
    const sent = port.sent[0];
    assert.equal(sent.op, 'application_resolve');
    port.onMessage.emit({ version: 1, id: sent.id, ok: true, result: { bindingId: 'binding:firefox' } });
    assert.deepEqual(await response, { bindingId: 'binding:firefox' });
    assert.deepEqual(hosts, [identity.nativeHost]);
    const pending = client.request('forms_validate', { formId: 'form:firefox', fields: [] });
    port.error = { message: 'Native host closed' }; // Firefox reports port.error, not callback lastError.
    port.onDisconnect.emit();
    await assert.rejects(pending, /Open Recruiters/);
    assert.equal(client.connected(), false);
  }
});

test('application projection retains only supported host availability and launch modes', () => {
  const view = applicationView({
    bindingId: 'binding:cli', state: 'needs_documents',
    handoff: { host: 'codex', state: 'awaiting_agent', requiresSend: true, mode: 'cli', prompt: 'private prompt' },
    hostInfo: {
      codex: { available: true, label: 'Codex CLI', mode: 'cli', command: '/private/agent' },
      claude: { available: false, label: 'Claude', mode: 'unknown', reason: 'Install Claude Code.' },
      untrusted: { available: true, label: 'Unsupported agent' },
    },
  });
  assert.equal(view.handoff.mode, 'cli');
  assert.deepEqual(Object.keys(view.hostInfo), ['claude', 'codex']);
  assert.equal(view.hostInfo.claude.available, false);
  assert.equal(view.hostInfo.claude.mode, null);
  assert.equal(view.hostInfo.codex.label, 'Codex CLI');
  assert.doesNotMatch(JSON.stringify(view), /private|Unsupported/);
});

test('external websites can only pair, read account connection status or open settings', () => {
  for (const op of ['status','open_settings']) assert.equal(safeDeviceRequest(request(op), origin).op, op);
  const pairing = { productOrigin: origin, pairing: { deviceId: randomUUID(), challenge: 'one-time', expiresAt: new Date(Date.now() + 60000).toISOString(), account: { id: 'synthetic', label: 'Synthetic' } } };
  assert.equal(safeDeviceRequest(request('pair', pairing), origin).op, 'pair');
  for (const op of ['capture_jobs','forms_prepare','forms_answer_save','forms_cancel','application_resolve','application_status','application_prepare','application_document','application_open_ad','application_host','application_copy_intro','career_facts','credential_read','connect_provider']) assert.throws(() => safeDeviceRequest(request(op), origin));
  assert.throws(() => safeDeviceRequest(request('status', { apiKey: 'secret' }), origin));
  assert.throws(() => safeDeviceRequest(request('pair', { ...pairing, productOrigin: 'https://other.test' }), origin));
  const port = { name: 'recruiters-device', sender: { url: `${origin}/account`, origin, tab: { id: 1 }, frameId: 0 } };
  assert.equal(externalSenderAllowed(port, origin), true);
  assert.equal(externalSenderAllowed({ ...port, sender: { ...port.sender, frameId: 1 } }, origin), false);
  assert.equal(externalSenderAllowed({ ...port, sender: { ...port.sender, origin: 'https://other.test' } }, origin), false);
  const result = deviceResult('status', { installed: true, paired: true, deviceId: 'device', publicKey: 'public', career: { facts: ['secret'] }, credentials: 'secret', decisionApiConfigured: true,
    applicationWorkflowVersion: 2, workflowVersion: 2, preferredHost: 'codex', hostInfo: { codex: { available: true, mode: 'desktop' } }, introduction: { ready: true },
    execution: { state: 'ready', private: 'secret' } });
  assert.deepEqual(result, { installed: true, mode: 'local_mcp', paired: true, deviceId: 'device', publicKey: 'public', connections: [], execution: { state: 'ready' } });
});

test('native replies correlate out of order, ignore unknown IDs and bound pending work', async () => {
  const port = fakePort(), client = createNativeClient({ host: 'synthetic', connect: () => port, maxPending: 2 });
  const first = client.request('status', {}), second = client.request('forms_prepare', { requestId: randomUUID() });
  assert.throws(() => client.request('status', {}), /busy/);
  port.onMessage.emit({ version: 1, id: randomUUID(), ok: true, result: 'wrong' });
  port.onMessage.emit({ version: 1, id: port.sent[1].id, ok: true, result: 'second' });
  port.onMessage.emit({ version: 1, id: port.sent[0].id, ok: true, result: 'first' });
  assert.deepEqual(await Promise.all([first, second]), ['first','second']);
  const third = client.request('status', {});
  port.disconnect();
  await assert.rejects(third, /Open Recruiters/);
});

test('native timeout and denial release request capacity for recovery', async () => {
  const port = fakePort(), client = createNativeClient({ host: 'synthetic', connect: () => port, maxPending: 1, timeoutMs: 5 });
  await assert.rejects(client.request('status', {}), /expired/);
  const denied = client.request('forms_prepare', {});
  port.onMessage.emit({ version: 1, id: port.sent.at(-1).id, ok: false, error: { message: 'Preparation cancelled.' } });
  await assert.rejects(denied, /cancelled/);
  const recovered = client.request('status', {});
  port.onMessage.emit({ version: 1, id: port.sent.at(-1).id, ok: true, result: { installed: true } });
  assert.deepEqual(await recovered, { installed: true });
});

function pageContext() {
  class Input {
    constructor(name, type = 'text', value = '') { this.name = name; this.id = name; this.type = type; this.tagName = 'INPUT'; this._value = value; this.labels = []; this.attrs = {}; this.autocomplete = ''; this.required = false; this.disabled = false; this.readOnly = false; this.isConnected = true; this.maxLength = -1; this.minLength = -1; this.events = []; }
    get value() { return this._value; } set value(v) { this._value = String(v); }
    get checked() { return this._checked === true; } set checked(value) { this._checked = Boolean(value); }
    getClientRects() { return this.hidden ? [] : [1]; }
    matches(selector) { return selector === ':disabled' && (this.disabled || this.fieldsetDisabled); }
    closest(selector) { return selector === 'input,textarea' && ['INPUT','TEXTAREA'].includes(this.tagName) ? this : selector === '[aria-disabled="true"]' && this.attrs['aria-disabled'] === 'true' ? this : null; }
    getAttribute(key) { return Object.hasOwn(this.attrs, key) ? this.attrs[key] : key === 'aria-label' ? this.name : null; }
    cloneNode() { return Object.assign(new Input(this.name, this.type, this.value), this, { attrs: { ...this.attrs }, events: [] }); }
    get validity() { return { valid: !this.invalid }; }
    dispatchEvent(event) { this.events.push(event.type); }
  }
  const controls = [new Input('Full name'), new Input('Email', 'email', 'already-entered@example.test'), new Input('Password', 'password'), new Input('Social security number'), new Input('Gender'), new Input('I agree to terms'), new Input('Resume', 'file')];
  const context = vm.createContext({ URL, crypto: { randomUUID }, location: { href: 'https://jobs.example.test/application' }, document: { title: 'Application', baseURI: 'https://jobs.example.test/application', forms: [], getElementById() { return null; }, querySelectorAll() { return controls; } }, getComputedStyle: () => ({ display: 'block', visibility: 'visible' }), HTMLInputElement: Input, HTMLSelectElement: Input, HTMLTextAreaElement: Input, Event: class { constructor(type) { this.type = type; } } });
  const invoke = (fn, request = null, expectedDocument = null) => { context.request = request; context.expectedDocument = expectedDocument; return vm.runInContext(`(${fn.toString()})(request, expectedDocument)`, context); };
  return { controls, context, invoke };
}

test('inspection excludes protected controls and never includes entered values', () => {
  const page = pageContext(), snapshot = page.invoke(inspectForm);
  assert.deepEqual(Array.from(snapshot.fields, f => f.label), ['Full name', 'Email']);
  assert.equal(snapshot.fields[1].empty, false);
  assert.equal(snapshot.fields[1].manualOnly, true);
  assert.equal(JSON.stringify(snapshot).includes('already-entered'), false);
});

test('inspection cannot write controls even when passed values from a previous snapshot', () => {
  const page = pageContext(), snapshot = page.invoke(inspectForm);
  page.invoke(inspectForm, { url: snapshot.url, fields: snapshot.fields.map(field => ({ ...field, value: 'Must not write' })) });
  assert.equal(page.controls[0].value, '');
  assert.equal(page.controls[1].value, 'already-entered@example.test');
  assert.deepEqual(page.controls.flatMap(control => control.events), []);
});

function contactPage(legend = 'Preferred contact method') {
  const page = pageContext(), Input = page.context.HTMLInputElement;
  const form = { id: 'application', action: 'https://jobs.example.test/application', method: 'post', getAttribute(key) { return this[key] ?? null; } };
  const fieldset = { querySelector: () => ({ textContent: legend }) };
  const radio = (value, label) => {
    const control = new Input('contact', 'radio', value);
    control.form = form; control.id = `${value}-radio`;
    control.closest = selector => selector === 'fieldset' ? fieldset : null;
    control.getAttribute = key => key === 'aria-label' ? label : null;
    return control;
  };
  page.controls[1] = radio('email', 'Email');
  const other = radio('phone', 'Phone'); page.controls.push(other);
  page.context.document.forms.push(form);
  return { ...page, other, radio };
}

test('contact method radio groups are inspected while contact consent stays protected', () => {
  const page = contactPage(), snapshot = page.invoke(inspectForm);
  const radio = snapshot.fields.find(field => field.type === 'radio');
  assert.equal(radio.label, 'Preferred contact method');
  assert.deepEqual(Array.from(radio.options, option => option.value), ['email', 'phone']);
  assert.equal(contactPage('Contact me').invoke(inspectForm).fields.some(field => field.type === 'radio'), false);
});

test('new radio members invalidate the inspected binding without changing values', () => {
  const page = contactPage(), snapshot = page.invoke(inspectForm);
  const inserted = page.radio('existing', 'Existing choice');
  inserted.checked = true;
  page.controls.push(inserted);
  assert.equal(page.invoke(checkFormBindings, snapshot).attached, false);
  assert.equal(inserted.checked, true);
  assert.equal(page.controls[1].checked, false);
  assert.equal(page.other.checked, false);
});

test('choice inspection exposes only actual nonempty options without selecting one', () => {
  const page = pageContext(), select = page.controls[0];
  select.name = 'Work mode'; select.tagName = 'SELECT'; select.type = 'select';
  select.options = [{ value: '', label: '' }, { value: 'remote', label: 'Remote' }, { value: 'office', label: 'Office' }];
  const snapshot = page.invoke(inspectForm), field = snapshot.fields[0];
  assert.equal(field.options.length, 2);
  assert.equal(field.options.some(option => option.value === ''), false);
  assert.equal(select.value, '');
});

function inertTemplate() {
  return { content: { textContent: '', querySelectorAll: () => [] }, set innerHTML(value) { this.content.textContent = value; } };
}
test('JSON-LD collection is bounded and preserves original metadata without invented dates', () => {
  const rows = Array.from({ length: 70 }, (_, i) => ({ '@type': 'JobPosting', title: `Role ${i}`, url: `https://jobs.example.test/jobs/${i}`, description: 'Original role description', hiringOrganization: { name: 'Synthetic employer' } }));
  const context = vm.createContext({ URL, location: { href: 'https://jobs.example.test/jobs' }, TextEncoder, document: { title: 'Roles', createElement: inertTemplate, querySelector: () => null, querySelectorAll: selector => selector.startsWith('script') ? [{ textContent: JSON.stringify({ '@graph': rows }) }] : [] } });
  const result = vm.runInContext(`(${captureJobs.toString()})()`, context);
  assert.equal(result.jobs.length, 50);
  assert.equal(result.jobs[0].complete, true);
  assert.equal(result.jobs[0].company, 'Synthetic employer');
  assert.equal(result.jobs[0].publishedAt, undefined);
  assert.ok(new TextEncoder().encode(JSON.stringify(result)).length <= 1024 * 1024);
});

function captureFixture({ metadata = [], original = null, cards = [] } = {}) {
  const textNode = text => ({ nodeType: 3, textContent: text });
  const element = (tagName, text = '', children = []) => ({ nodeType: 1, tagName, textContent: text, childNodes: children.length ? children : [textNode(text)], getClientRects: () => [1], closest: () => null });
  const heading = element('H1', 'Synthetic role');
  const originalElement = original === null ? null : element('DIV', '', Array.isArray(original) ? original.map(text => element('P', text)) : [textNode(original)]);
  const context = vm.createContext({ URL, TextEncoder, location: { href: 'https://jobs.example.test/jobs/synthetic' }, getComputedStyle: () => ({ display: 'block', visibility: 'visible' }),
    document: { title: 'Synthetic role', createElement: inertTemplate, querySelector(selector) { if (selector === 'main h1,h1') return heading; if (selector.includes('job-description')) return originalElement; return null; }, querySelectorAll(selector) { return selector.startsWith('script') ? [{ textContent: JSON.stringify(metadata) }] : cards; } },
  });
  return { run: () => vm.runInContext(`(${captureJobs.toString()})()`, context), element };
}

test('a complete rendered original upgrades incomplete JSON-LD while keeping factual metadata', () => {
  const fixture = captureFixture({ metadata: [{ '@type': 'JobPosting', title: 'Synthetic role', url: 'https://jobs.example.test/jobs/synthetic', hiringOrganization: { name: 'Synthetic employer' }, datePosted: '2026-10-01' }], original: 'Original responsibilities and requirements. '.repeat(10) });
  const result = fixture.run();
  assert.equal(result.jobs.length, 1);
  assert.equal(result.jobs[0].complete, true);
  assert.equal(result.jobs[0].company, 'Synthetic employer');
  assert.equal(result.jobs[0].publishedAt, '2026-10-01');
  assert.match(result.jobs[0].description, /Original responsibilities/);
});

test('clipped JSON-LD, rendered text and rendered traversal never claim a full advert', () => {
  const long = 'Long original description. '.repeat(4000);
  const json = captureFixture({ metadata: [{ '@type': 'JobPosting', title: 'Synthetic role', description: long }] }).run();
  assert.equal(json.jobs[0].complete, false);
  assert.equal(captureFixture({ original: long }).run().jobs[0].complete, false);
  assert.equal(captureFixture({ original: Array.from({ length: 2600 }, () => 'Original role text.') }).run().jobs[0].complete, false);
});

test('visible listing cards remain partial captures and never inherit input contents', () => {
  const cards = [], fixture = captureFixture({ cards });
  const heading = fixture.element('H2', 'Visible listing role'), link = fixture.element('A', 'Visible listing role');
  link.href = 'https://jobs.example.test/jobs/listed'; link.getAttribute = () => '/jobs/listed';
  const input = fixture.element('TEXTAREA', 'private entered answer');
  const card = fixture.element('ARTICLE', '', [heading, input]); card.querySelectorAll = () => [link]; card.querySelector = selector => selector.startsWith('h2') ? heading : null; cards.push(card);
  const result = fixture.run();
  assert.equal(result.jobs.length, 1);
  assert.equal(result.jobs[0].complete, false);
  assert.equal(result.jobs[0].title, 'Visible listing role');
  assert.equal(result.jobs[0].description.includes('private entered answer'), false);
});

test('companion attachment commands arrive on the native port and are answered in place', async () => {
  const seen = [];
  const port = fakePort(), client = createNativeClient({ host: 'synthetic', connect: () => port, onCommand: async (op, payload) => {
    seen.push([op, payload]);
    if (payload.formId === 'missing') throw new Error('The page changed.');
    return { attached: true };
  } });
  const status = client.request('status', {});
  const attached = request('forms_status', { formId: 'form:1' }), missing = request('forms_status', { formId: 'missing' });
  port.onMessage.emit(attached); port.onMessage.emit(missing);
  await tick();
  assert.deepEqual(seen, [['forms_status', attached.payload], ['forms_status', missing.payload]]);
  const replies = port.sent.filter(message => Object.hasOwn(message, 'ok'));
  assert.deepEqual(replies[0], { version: 1, id: attached.id, ok: true, result: { attached: true } });
  assert.deepEqual(replies[1], { version: 1, id: missing.id, ok: false, error: { message: 'The page changed.' } });
  port.onMessage.emit(attached);
  await tick();
  assert.equal(seen.length, 2);
  assert.match(port.sent.at(-1).error.message, /already received/);
  port.onMessage.emit({ version: 1, id: port.sent[0].id, ok: true, result: { installed: true } });
  assert.deepEqual(await status, { installed: true });
  client.disconnect();
});

test('duplicate in-flight attachment commands wait for the original asynchronous result', async () => {
  const port = fakePort();
  let release, calls = 0;
  const client = createNativeClient({ host: 'synthetic', connect: () => port, onCommand: () => { calls++; return new Promise(resolve => { release = resolve; }); } });
  const status = client.request('status', {});
  const command = request('forms_status', { formId: 'form:1' });
  port.onMessage.emit(command);
  await tick();
  port.onMessage.emit(command);
  assert.equal(port.sent.filter(message => message.id === command.id).length, 0);
  release({ attached: true });
  await tick();
  assert.equal(calls, 1);
  assert.deepEqual(port.sent.filter(message => message.id === command.id).map(message => message.result.attached), [true]);
  port.onMessage.emit({ version: 1, id: port.sent[0].id, ok: true, result: {} });
  await status;
  client.disconnect();
});

test('native commands reject unknown, oversized and malformed attachment requests', () => {
  const status = request('forms_status', { formId: 'form:1' });
  assert.deepEqual(safeNativeCommand(status), { op: status.op, payload: status.payload });
  for (const message of [
    { ...status, op: 'evaluate' },
    { ...status, id: 'not-a-uuid' },
    { ...status, extra: true },
    { ...status, payload: { ...status.payload, script: 'bad' } },
    { ...status, payload: {} },
    { ...status, payload: { formId: '' } },
    { ...status, payload: { formId: 1 } },
    { ...status, payload: { formId: 'x'.repeat(101) } },
    { ...status, payload: { formId: 'x'.repeat(1024 * 1024) } },
  ]) assert.throws(() => safeNativeCommand(message));
});

test('unsupported native commands are rejected before dispatch', async () => {
  const port = fakePort(), client = createNativeClient({ host: 'synthetic', connect: () => port, onCommand: () => assert.fail('Unsupported command dispatched') });
  const status = client.request('status', {});
  const commands = [
    request('forms_fill', { requestId: randomUUID(), formId: 'form:1', fields: [], answers: [] }),
    request('forms_submit', { requestId: randomUUID(), formId: 'form:1', actionId: 'send', actionSignature: 'signature' }),
    request('evaluate', { script: 'document.forms[0].submit()' }),
  ];
  for (const command of commands) port.onMessage.emit(command);
  await tick();
  for (const command of commands) {
    const reply = port.sent.find(message => message.id === command.id);
    assert.equal(reply.ok, false);
    assert.match(reply.error.message, /invalid or unavailable/);
  }
  port.onMessage.emit({ version: 1, id: port.sent[0].id, ok: true, result: {} });
  await status;
  client.disconnect();
});

test('native command concurrency is bounded and reply send failures disconnect safely', async () => {
  const port = fakePort();
  let release, calls = 0;
  const client = createNativeClient({ host: 'synthetic', connect: () => port, maxPending: 1, onCommand: () => { calls++; return new Promise(resolve => { release = resolve; }); } });
  const status = client.request('status', {});
  const rejected = assert.rejects(status, /Open Recruiters/);
  port.onMessage.emit(request('forms_status', { formId: 'form:1' }));
  port.onMessage.emit(request('forms_status', { formId: 'form:1' }));
  await tick();
  assert.equal(calls, 1);
  assert.match(port.sent.at(-1).error.message, /busy/);
  port.postMessage = () => { throw new Error('Disconnected while replying'); };
  release({ attached: true });
  await rejected;
  await tick();
  assert.equal(client.connected(), false);
});

test('native request send failure rejects and notifies disconnect exactly once', async () => {
  const port = fakePort();
  let disconnected = 0;
  port.postMessage = () => { throw new Error('Native send failed'); };
  const client = createNativeClient({ host: 'synthetic', connect: () => port, onDisconnect: () => { disconnected++; } });
  await assert.rejects(client.request('forms_validate', { formId: 'form:1', fields: [] }), { code: 'COMPANION_UNAVAILABLE' });
  assert.equal(client.connected(), false);
  assert.equal(disconnected, 1);
  client.disconnect();
  assert.equal(disconnected, 1);
});

const plain = value => JSON.parse(JSON.stringify(value));
function pastePage() {
  const page = pageContext();
  class Button extends page.context.HTMLInputElement {
    constructor(label, type = 'submit') { super('', type); this.tagName = 'BUTTON'; this.textContent = label; this.clicks = 0; this.form = null; }
    click() { this.clicks++; }
  }
  const buttons = [new Button('Submit application'), new Button('Cancel', 'button'), new Button('Next step', 'button')];
  const listeners = {}, windowCapture = {}, messages = [], clipboard = [], alerts = [], frames = [], busy = [];
  let responder = () => ({ value: null });
  page.context.document.querySelectorAll = selector => selector.startsWith('button') ? buttons
    : selector === 'iframe' ? frames : selector === '[aria-busy="true"]' ? busy
      : selector.includes('alert') ? [...alerts, ...page.controls.filter(el => el.attrs['aria-invalid'] === 'true')] : page.controls;
  page.context.document.addEventListener = (type, fn) => { listeners[type] = fn; };
  page.context.document.removeEventListener = (type, fn) => { if (listeners[type] === fn) delete listeners[type]; };
  page.context.addEventListener = (type, fn, options) => {
    listeners[`window:${type}`] = fn;
    windowCapture[type] = options === true || options?.capture === true;
  };
  page.context.document.body = { innerText: 'Apply for this role. Full name. Email address.' };
  page.context.document.visibilityState = 'visible';
  page.context.document.hasFocus = () => true;
  page.context.navigator = { clipboard: { writeText: async value => { clipboard.push(value); } } };
  page.context.chrome = { runtime: { lastError: null, sendMessage: (message, callback) => {
    messages.push(message);
    if (message.action === 'paste-value') Promise.resolve(responder(message)).then(callback);
    else callback?.();
  } } };
  const focus = (el, { tab = false, trusted = true } = {}) => {
    if (tab) listeners.keydown({ key: 'Tab', isTrusted: trusted });
    else listeners.pointerdown({ target: el, button: 0, isTrusted: trusted });
    if (page.context.document.activeElement) {
      // Native element blur travels through window's capture phase before
      // focusout and the next control's focusin.
      if (windowCapture.blur) listeners['window:blur']({ target: page.context.document.activeElement });
      listeners.focusout({});
    }
    page.context.document.activeElement = el;
    listeners.focusin({ target: el, isTrusted: trusted });
  };
  return { ...page, buttons, listeners, messages, clipboard, alerts, frames, busy, focus, respond: fn => { responder = fn; } };
}

// Ashby renders Yes/No as `<label>` then `<div><button aria-pressed="false">Yes</button><button aria-pressed="false">No</button><input type="checkbox" hidden></div>`.
function yesNoPage(question = 'Do you have at least 1+ years of experience in leadership?') {
  const page = pastePage(), Input = page.context.HTMLInputElement;
  const label = { tagName: 'LABEL', textContent: question, cloneNode() { return { textContent: question, querySelectorAll: () => [] }; } };
  const box = { tagName: 'DIV', children: [], previousElementSibling: label, parentElement: null, getAttribute: () => null, closest: () => null };
  const options = ['Yes', 'No'].map(text => {
    const button = new Input('', 'submit');
    Object.assign(button, { tagName: 'BUTTON', textContent: text, parentElement: box, attrs: { 'aria-pressed': 'false' } });
    box.children.push(button);
    return button;
  });
  page.controls.push(...options); page.buttons.push(...options);
  return { ...page, options };
}

test('labelled Yes/No button groups are one choice field, never submit controls, and inspection presses nothing', () => {
  const page = yesNoPage(), snapshot = page.invoke(inspectForm);
  const choice = snapshot.fields.find(field => field.type === 'radio');
  assert.equal(choice.label, 'Do you have at least 1+ years of experience in leadership?');
  assert.deepEqual(plain(choice.options), [{ value: 'Yes', label: 'Yes' }, { value: 'No', label: 'No' }]);
  assert.equal(choice.empty, true); assert.equal(choice.manualOnly, false);
  assert.deepEqual(Array.from(snapshot.actions, action => action.label), ['Submit application', 'Next step']);
  assert.deepEqual(page.options.map(option => option.attrs['aria-pressed']), ['false', 'false']);
  page.options[0].attrs['aria-pressed'] = 'true';
  assert.equal(page.invoke(checkFormBindings, snapshot).attached, true, 'the user clicking an option keeps the page bound');
  const answered = page.invoke(inspectForm).fields.find(field => field.type === 'radio');
  assert.equal(answered.empty, false); assert.equal(answered.manualOnly, true);
  assert.equal(yesNoPage('What is your gender?').invoke(inspectForm).fields.some(field => field.type === 'radio'), false);
});

test('Firefox Promise messaging prepares the native clipboard only while the inspected field retains focus', async () => {
  for (const outcome of ['success', 'blur', 'permission', 'disconnected']) {
    const page = pastePage(), snapshot = page.invoke(inspectForm), messages = [];
    let resolve;
    page.context.browser = { runtime: { sendMessage(message) {
      assert.equal(arguments.length, 1, 'Firefox messaging must not receive a Chrome callback');
      messages.push(message);
      if (outcome === 'disconnected') return Promise.reject(new Error('Native extension disconnected'));
      return message.action === 'paste-value' ? new Promise(done => { resolve = done; }) : Promise.resolve();
    } } };
    delete page.context.chrome;
    page.invoke(armSmartPaste, { session: randomUUID() });
    page.focus(page.controls[0]);
    assert.equal(messages[0].documentToken, snapshot.documentToken);
    if (outcome === 'blur') { page.listeners['window:blur'](); page.context.document.hasFocus = () => false; }
    if (outcome === 'permission') page.context.navigator.clipboard.writeText = () => Promise.reject(new Error('Clipboard permission denied'));
    resolve?.({ value: 'Synthetic Firefox Candidate' });
    await tick();
    assert.deepEqual(page.clipboard, outcome === 'success' ? ['Synthetic Firefox Candidate'] : []);
    if (outcome === 'success' || outcome === 'permission') {
      assert.equal(messages.at(-1).action, 'paste-ready');
      assert.equal(messages.at(-1).ok, outcome === 'success');
    } else assert.equal(messages.length, 1);
    assert.equal(page.controls[0].value, '');
    assert.deepEqual(page.controls[0].events, []);
  }
});

test('switching through seven fields replaces the clipboard after earlier fields are pasted', async () => {
  for (const tab of [false, true]) {
    const page = pastePage(), Input = page.context.HTMLInputElement;
    const values = ['Synthetic Candidate', 'candidate@example.test', 'San Francisco, CA',
      'https://x.com/synthetic_candidate', 'Synthetic Studio', 'Co-founder & CEO', 'First line.\nSecond line.'];
    const labels = ['Full name', 'Email', 'Location', 'X profile', 'Current company', 'Current role', 'Professional summary'];
    page.controls.splice(0, page.controls.length, ...labels.map((label, i) => new Input(label, i === 1 ? 'email' : i === 3 ? 'url' : 'text')));
    const snapshot = page.invoke(inspectForm);
    page.invoke(armSmartPaste, { session: randomUUID() });
    page.respond(({ fieldId }) => ({ value: values[snapshot.fields.findIndex(field => field.id === fieldId)] }));
    for (let i = 0; i < values.length; i++) {
      page.focus(page.controls[i], { tab });
      await tick();
      assert.equal(page.clipboard.at(-1), values[i], `${labels[i]} must replace the prior field's clipboard value`);
      page.controls[i].value = page.clipboard.at(-1);
    }
    assert.deepEqual(page.clipboard, values);
    assert.deepEqual(page.controls.map(control => control.value), values);
  }
});

test('inspected actions remain read-only context across reinspection', () => {
  const page = pastePage(), snapshot = page.invoke(inspectForm);
  assert.deepEqual(plain(snapshot.actions.map(({ label, kind }) => ({ label, kind }))), [{ label: 'Submit application', kind: 'submit' }, { label: 'Next step', kind: 'next' }]);
  const again = page.invoke(inspectForm);
  assert.equal(again.actions[0].signature, snapshot.actions[0].signature);
  assert.equal(page.invoke(checkFormBindings, snapshot).attached, true);
  assert.deepEqual(page.buttons.map(button => button.clicks), [0, 0, 0]);
});

test('attachment rejects changed labels, nodes, form destinations, submitter overrides and documents', () => {
  for (const mutate of [
    page => { page.buttons[0].textContent = 'Delete account'; },
    page => { page.buttons[0].form.action = 'https://other.example.test/collect'; },
    page => { page.buttons[0].attrs.formaction = 'https://other.example.test/collect'; },
    page => { page.buttons[0].formMethod = 'get'; },
    page => { page.buttons[0].formTarget = '_blank'; },
    page => { page.buttons[0].form = { ...page.buttons[0].form }; },
    page => { page.buttons[0].fieldsetDisabled = true; },
    page => { page.buttons[0].hidden = true; },
    page => { page.buttons[0].isConnected = false; page.buttons[0] = new page.buttons[0].constructor('Submit application'); },
    page => { page.context.location.href += '?changed=true'; },
  ]) {
    const page = pastePage();
    page.buttons[0].form = { action: page.context.location.href, method: 'post', enctype: 'application/x-www-form-urlencoded', target: '', getAttribute(key) { return this[key] ?? null; } };
    const snapshot = page.invoke(inspectForm), original = page.buttons[0];
    mutate(page);
    assert.equal(page.invoke(checkFormBindings, snapshot).attached, false);
    assert.equal(original.clicks, 0);
    assert.equal(page.buttons[0].clicks, 0);
  }
});

test('rebound action IDs cannot reuse an earlier inspection signature', () => {
  const page = pastePage(), snapshot = page.invoke(inspectForm);
  page.buttons[0].attrs.formaction = '/different';
  const changed = page.invoke(inspectForm);
  assert.notEqual(changed.actions[0].signature, snapshot.actions[0].signature);
  assert.equal(page.invoke(checkFormBindings, snapshot).attached, false);
  assert.equal(page.invoke(checkFormBindings, changed).attached, true);
  assert.equal(page.buttons[0].clicks, 0);
});

test('smart paste uses native clipboard only after a trusted click or Tab onto an empty inspected field', async () => {
  const page = pastePage(), snapshot = page.invoke(inspectForm), session = randomUUID();
  assert.deepEqual(plain(page.invoke(armSmartPaste, { session })), { armed: true, fields: 1 });
  page.respond(() => ({ value: 'Synthetic Candidate' }));
  page.context.document.activeElement = page.controls[0];
  page.listeners.focusin({ target: page.controls[0], isTrusted: true });
  page.focus(page.controls[0], { trusted: false });
  await tick();
  assert.equal(page.messages.length, 0);
  page.focus(page.controls[0]);
  await tick();
  const identity = { fieldId: snapshot.fields[0].id, signature: snapshot.fields[0].signature, url: snapshot.url, session, documentToken: snapshot.documentToken };
  assert.deepEqual(plain(page.messages[0]), { action: 'paste-value', ...identity });
  assert.deepEqual(plain(page.messages[1]), { action: 'paste-ready', ...identity, ok: true });
  assert.deepEqual(page.clipboard, ['Synthetic Candidate']);
  assert.deepEqual(page.controls[0].events, []);
  assert.equal(page.controls[0].value, '');
  assert.equal(page.listeners.paste, undefined);
  page.focus(page.controls[0], { tab: true });
  await tick();
  assert.equal(page.clipboard.length, 2);
  page.focus(page.controls[1]); // Already populated.
  page.focus(page.controls[2]); // Password.
  await tick();
  assert.equal(page.clipboard.length, 2);
  assert.equal(page.messages.filter(message => message.action === 'paste-value').length, 2);
});

test('clicking an already focused field refreshes its answer after rearming', async () => {
  const page = pastePage(), el = page.controls[0];
  page.invoke(inspectForm);
  page.invoke(armSmartPaste, { session: randomUUID() });
  page.respond(() => ({ value: 'Previous answer' }));
  page.focus(el);
  await tick();
  page.invoke(disarmSmartPaste);
  page.invoke(armSmartPaste, { session: randomUUID() });
  page.respond(() => ({ value: 'New job-specific summary' }));
  // Clicking the same DOM control does not emit another focusin.
  page.listeners.pointerdown({ target: el, button: 0, isTrusted: true });
  page.listeners.click?.({ target: el, button: 0, isTrusted: true });
  await tick();
  assert.equal(page.clipboard.at(-1), 'New job-specific summary');
  assert.equal(el.value, '');
});

test('clearing a mistaken paste refreshes only an eligible empty focused control', async () => {
  for (const scenario of ['cleared', 'untrusted', 'populated', 'protected', 'disarmed']) {
    const page = pastePage(), el = page.controls[0];
    page.invoke(inspectForm);
    page.invoke(armSmartPaste, { session: randomUUID() });
    page.context.document.activeElement = el;
    page.respond(() => ({ value: 'Prepared summary' }));
    el.value = scenario === 'populated' ? 'Keep my text' : '';
    if (scenario === 'protected') el.type = 'password';
    if (scenario === 'disarmed') page.invoke(disarmSmartPaste);
    page.listeners.input?.({ target: el, isTrusted: scenario !== 'untrusted' });
    await tick();
    assert.deepEqual(page.clipboard, scenario === 'cleared' ? ['Prepared summary'] : []);
    assert.equal(el.value, scenario === 'populated' ? 'Keep my text' : '');
  }
});

test('changed, protected, hidden and populated fields never request clipboard data', async () => {
  for (const mutate of [
    page => { page.controls[0].type = 'password'; },
    page => { page.controls[0].name = 'Social security number'; },
    page => { page.controls[0].autocomplete = 'cc-number'; },
    page => { page.controls[0].attrs.title = 'Social security number'; },
    page => { page.controls[0].attrs.placeholder = 'Credit card number'; },
    page => { page.controls[0].value = 'User answer'; },
    page => { page.controls[0].readOnly = true; },
    page => { page.controls[0].fieldsetDisabled = true; },
    page => { page.controls[0].hidden = true; },
    page => { page.controls[0].attrs.pattern = '[0-9]+'; },
    page => { page.controls[0].isConnected = false; page.controls[0] = new page.context.HTMLInputElement('Full name'); },
    page => { page.context.location.href += '?changed'; },
  ]) {
    const page = pastePage(); page.invoke(inspectForm); page.invoke(armSmartPaste, { session: randomUUID() });
    page.respond(() => ({ value: 'Must not release' }));
    mutate(page); page.focus(page.controls[0]);
    await tick();
    assert.equal(page.messages.length, 0);
    assert.equal(page.clipboard.length, 0);
  }
});

test('pending clipboard responses cannot outlive disarm, focus, field or inspection changes', async () => {
  for (const mutate of [
    page => { page.invoke(disarmSmartPaste); },
    page => { page.invoke(disarmSmartPaste); page.invoke(armSmartPaste, { session: randomUUID() }); },
    page => { page.listeners.focusout({}); page.context.document.activeElement = page.controls[1]; },
    page => { page.listeners.focusout({}); page.context.document.activeElement = page.controls[0]; },
    page => { page.listeners['window:blur'](); },
    page => { page.context.document.visibilityState = 'hidden'; page.listeners.visibilitychange(); },
    page => { page.controls[0].type = 'password'; },
    page => { page.controls[0].attrs.title = 'Social security number'; },
    page => { page.controls[0].value = 'Entered while waiting'; },
    page => { page.controls[0].isConnected = false; },
    page => { page.invoke(inspectForm); },
  ]) {
    const page = pastePage(); page.invoke(inspectForm); page.invoke(armSmartPaste, { session: randomUUID() });
    let resolve;
    page.respond(() => new Promise(done => { resolve = done; }));
    page.focus(page.controls[0]);
    assert.equal(page.messages.length, 1);
    mutate(page); resolve({ value: 'Must not write' });
    await tick();
    assert.equal(page.clipboard.length, 0);
    assert.equal(page.messages.some(message => message.action === 'paste-ready'), false);
  }
});

test('clipboard permission failures and extension send failures never use a synthetic fallback', async () => {
  const page = pastePage(); page.invoke(inspectForm); page.invoke(armSmartPaste, { session: randomUUID() });
  page.respond(() => ({ value: 'Candidate' }));
  page.context.navigator.clipboard.writeText = async () => { throw new Error('Permission denied'); };
  page.focus(page.controls[0]); await tick();
  assert.equal(page.messages.at(-1).ok, false);
  assert.deepEqual(page.clipboard, []);
  assert.deepEqual(page.controls[0].events, []);
  page.context.chrome.runtime.sendMessage = () => { throw new Error('Extension disconnected'); };
  assert.doesNotThrow(() => page.focus(page.controls[0]));
  assert.deepEqual(page.clipboard, []);
});

const applicationMetadata = (overrides = {}) => ({
  bindingId: 'binding:synthetic', formId: 'form:synthetic', applicationId: 'application:synthetic', title: 'Engineer', company: 'Example',
  state: 'needs_documents', documents: [{ kind: 'cv', label: 'CV', ready: false }, { kind: 'cover_letter', label: 'Cover letter', ready: false }],
  writing: [{ fieldId: 'writing', label: 'Why this role?', ready: false }], handoff: null, answerVersion: null, jobUrl: 'https://jobs.example.test/role',
  ...overrides,
});
async function backgroundFixture(page = pastePage(), options = {}) {
  const calls = [], injections = [], timers = new Map();
  let nextTimer = 0, application = applicationMetadata({ applicationId: null, ...options.application });
  let resolveApplication = async () => application, applicationStatus = async () => application;
  let launchApplication = async payload => (application = { ...application, handoff: { host: payload.host, state: 'awaiting_agent', requiresSend: true, mode: 'desktop' }, preferredHost: payload.host, opened: true, requiresSend: true, mode: 'desktop' });
  let nativeOptions, messageHandler, access, documentId = 'document-1', permission = true, validate = async () => ({ valid: true });
  let saveAnswer = async payload => ({ fieldId: payload.fieldId, scope: 'future' });
  let preferredHost = options.preferredHost ?? null;
  let readStatus = async () => ({ installed: true, paired: false, hasCv: options.hasCv ?? true, applicationWorkflowVersion: 2, preferredHost, hostInfo: { codex: { available: true, mode: 'desktop' }, claude: { available: true, mode: 'desktop' } }, decisionApiConfigured: false, execution: { state: 'ready' }, career: { facts: ['must not reach panel'] } });
  let copyIntro = async () => ({ copied: true });
  const createdTabs = [];
  let prepareResult = options.prepare || (payload => ({ formId: 'form:synthetic', snapshot: 'snapshot:synthetic', fields: payload.fields.filter(field => field.empty && !field.manualOnly).slice(0, 1).map(field => ({ ...field, value: 'Synthetic Candidate' })),
    unresolved: payload.fields.filter(field => field.empty && !field.manualOnly).slice(1).map(({ id, label }) => ({ id, label, reason: 'No known answer.', add: true })) }));
  const extensionId = options.firefox ? BROWSER_IDENTITIES.local.firefoxExtensionId : 'extension';
  const extensionOrigin = options.firefox ? `moz-extension://${randomUUID()}` : 'chrome-extension://extension';
  const nativePort = fakePort(), nativeHosts = [];
  const chrome = {
    runtime: { id: extensionId, ...(!options.firefox ? { onConnectExternal: event() } : {}), onConnect: event(), onMessage: { addListener(fn) { messageHandler = fn; } }, getURL: path => `${extensionOrigin}/${path}`,
      connectNative(host) { nativeHosts.push(host); return nativePort; } },
    permissions: { contains: async () => permission },
    alarms: { onAlarm: event(), create: async () => {} },
    tabs: { get: async () => ({ id: 7, url: page.context.location.href, title: 'Application', status: 'complete' }), create: async options => { createdTabs.push(options); }, onActivated: event(), onUpdated: event(), onRemoved: event() },
    ...(options.firefox ? { sidebarAction: {} } : { sidePanel: {} }), scripting: {},
  };
  const context = vm.createContext({
    [options.firefox ? 'browser' : 'chrome']: chrome, crypto: { randomUUID }, URL, PRODUCT_ORIGIN: origin, NATIVE_HOST: 'synthetic', BUILD_ID: 'test-build',
    captureJobs, captureApplicationContext, inspectForm, checkFormBindings, armSmartPaste, disarmSmartPaste,
    safeDeviceRequest, externalSenderAllowed, deviceResult, applicationView, preparedPageSender, reviewIdentity, installManagedUpdates,
    setTimeout(fn, ms) {
      if (ms === 5000) { const id = ++nextTimer; timers.set(id, fn); return id; }
      return setTimeout(fn, 0);
    },
    clearTimeout(id) { if (!timers.delete(id)) clearTimeout(id); },
    createPageAccess: accessOptions => {
      access = accessOptions.onAccess;
      return async (tabId, fn, args = [], expectedDocument = null) => {
        injections.push(fn.name);
        if (expectedDocument && expectedDocument !== documentId) throw new Error('The page changed.');
        const result = fn === captureJobs ? { jobs: options.jobs || [] } : fn === captureApplicationContext ? options.context || {} : page.invoke(fn, args[0] ?? null, options.firefox ? expectedDocument : null);
        if (options.firefox && fn === inspectForm) documentId = result.documentToken;
        const { documentToken, ...snapshot } = result;
        return { page: snapshot, documentId };
      };
    },
    createNativeClient: options => {
      nativeOptions = options;
      return { idle: () => true, request: async (op, payload) => {
        calls.push([op, plain(payload)]);
        if (op === 'status') return readStatus();
        if (op === 'forms_validate') return validate(payload);
        if (op === 'forms_prepare') return prepareResult(payload);
        if (op === 'forms_answer_save') return saveAnswer(payload);
        if (op === 'forms_cancel') return { cancelled: true };
        if (op === 'application_resolve') return resolveApplication(payload);
        if (op === 'application_status') return applicationStatus(payload);
        if (op === 'application_prepare') return launchApplication(payload);
        if (op === 'application_host') { preferredHost = payload.host; return { host: preferredHost }; }
        if (op === 'application_copy_intro') return copyIntro(payload);
        if (op === 'application_document' || op === 'application_open_ad') return { opened: true };
        throw new Error(`Unexpected request: ${op}`);
      } };
    },
  });
  const source = await readFile(new URL('../browser-extension/src/background.mjs', import.meta.url), 'utf8');
  vm.runInContext(source.replace(/^import .*;\r?\n/gm, ''), context);
  const act = async message => { context.message = message; await vm.runInContext('act(message)', context); };
  await act({ action: 'detect', payload: { tabId: 7 } });
  const state = () => vm.runInContext('state', context);
  if (!options.prepare) assert.equal(state().error, '');
  page.context.chrome.runtime.sendMessage = (message, callback) => {
    page.messages.push(message);
    const asynchronous = messageHandler(message, { id: extensionId, tab: { id: 7 }, frameId: 0, ...(!options.firefox ? { documentId } : {}) }, callback ?? (() => {}));
    if (!asynchronous && message.action !== 'paste-value') callback?.();
  };
  if (options.firefox) page.context.browser = { runtime: { sendMessage: message => new Promise(resolve => page.context.chrome.runtime.sendMessage(message, resolve)) } };
  return {
    page, calls, injections, state, act, createdTabs,
    status: fn => { readStatus = fn; },
    nativeHosts, nativePort, connectNative: () => nativeOptions.connect(nativeOptions.host),
    command(op, payload) { const command = safeNativeCommand(request(op, payload)); return nativeOptions.onCommand(command.op, command.payload); },
    disconnect: () => nativeOptions.onDisconnect(),
    validate: fn => { validate = fn; },
    permission: value => { permission = value; },
    navigate: value => { documentId = value; },
    answerSave: fn => { saveAnswer = fn; },
    prepare: fn => { prepareResult = fn; },
    toolbar: tabId => access(tabId),
    application: value => { application = value; },
    resolveApplication: fn => { resolveApplication = fn; },
    applicationStatus: fn => { applicationStatus = fn; },
    launchApplication: fn => { launchApplication = fn; },
    copyIntro: fn => { copyIntro = fn; },
    connectPanel(sender = { id: extensionId, url: chrome.runtime.getURL('panel.html') }) { const panel = fakePort(); panel.name = 'recruiters-panel'; panel.sender = sender; chrome.runtime.onConnect.emit(panel); return panel; },
    poll: () => vm.runInContext('pollApplication()', context),
    get scheduledPolls() { return timers.size; },
    activate: tabId => chrome.tabs.onActivated.emit({ tabId }),
    updateTab: (tabId, change) => chrome.tabs.onUpdated.emit(tabId, change),
    removeTab: tabId => chrome.tabs.onRemoved.emit(tabId),
  };
}

test('Firefox background authenticates dynamic sidebar URLs, native host and token-bound clipboard messages', async () => {
  const fixture = await backgroundFixture(pastePage(), { firefox: true });
  assert.ok(fixture.state().prepared);
  assert.equal(fixture.connectNative(), fixture.nativePort);
  assert.deepEqual(fixture.nativeHosts, ['synthetic']);
  const panel = fixture.connectPanel();
  assert.equal(panel.sent.length, 1, 'runtime.getURL accepts Firefox dynamic moz-extension origin');
  for (const url of [`moz-extension://${BROWSER_IDENTITIES.local.firefoxExtensionId}/panel.html`, 'https://recruiters.rip/panel.html', 'chrome-extension://extension/panel.html'])
    assert.equal(fixture.connectPanel({ id: BROWSER_IDENTITIES.local.firefoxExtensionId, url }).sent.length, 0);
  fixture.page.focus(fixture.page.controls[0]); await tick();
  assert.deepEqual(fixture.page.clipboard, ['Synthetic Candidate']);
  assert.equal(fixture.state().paste.ok, true);
  fixture.updateTab(7, { status: 'loading' });
  assert.equal(fixture.state().prepared, null);
  fixture.page.focus(fixture.page.controls[0]); await tick();
  assert.equal(fixture.page.clipboard.length, 1, 'navigation cannot deliver a stale prepared answer');
  panel.disconnect();
});

test('browser status checks live bindings, URL and Chrome document identity', async () => {
  for (const mutate of [
    fixture => { fixture.page.controls[0].type = 'password'; },
    fixture => { fixture.page.buttons[0].attrs.formaction = '/different'; },
    fixture => { fixture.page.context.location.href += '?changed'; },
    fixture => { fixture.navigate('document-2'); },
  ]) {
    const fixture = await backgroundFixture(), formId = fixture.state().prepared.formId;
    assert.equal((await fixture.command('forms_status', { formId })).attached, true);
    mutate(fixture);
    assert.deepEqual(plain(await fixture.command('forms_status', { formId })), { formId, attached: false });
    assert.equal(fixture.state().prepared, null);
  }
});

test('clipboard release requires current companion validation and permission on every focus', async () => {
  const fixture = await backgroundFixture(), prepared = fixture.state().prepared;
  fixture.page.focus(fixture.page.controls[0]);
  await tick();
  assert.deepEqual(fixture.page.clipboard, ['Synthetic Candidate']);
  assert.deepEqual(fixture.calls.at(-1), ['forms_validate', {
    formId: prepared.formId, fields: plain(fixture.state().form.fields.map(({ id, signature }) => ({ id, signature }))),
  }]);
  fixture.validate(async () => { throw new Error('Companion locked or evidence changed'); });
  fixture.page.focus(fixture.page.controls[0], { tab: true });
  await tick();
  assert.deepEqual(fixture.page.clipboard, ['Synthetic Candidate']);
  assert.equal(fixture.state().prepared, null);
  const denied = await backgroundFixture();
  denied.permission(false);
  denied.page.focus(denied.page.controls[0]);
  await tick();
  assert.deepEqual(denied.page.clipboard, []);
  assert.equal(denied.state().prepared, null);
});

test('native disconnect invalidates prepared values and any pending clipboard response', async () => {
  const fixture = await backgroundFixture();
  let release;
  fixture.validate(() => new Promise(resolve => { release = resolve; }));
  fixture.page.focus(fixture.page.controls[0]);
  await tick();
  fixture.disconnect();
  release({ valid: true });
  await tick();
  assert.equal(fixture.state().prepared, null);
  assert.deepEqual(fixture.page.clipboard, []);
  fixture.page.focus(fixture.page.controls[0]);
  await tick();
  assert.equal(fixture.calls.filter(([op]) => op === 'forms_validate').length, 1);
});

test('form destination attributes stay bound even when a named control shadows form.action', () => {
  const page = pastePage(), attrs = { action: '/approved', method: 'post' };
  page.buttons[0].form = { action: {}, getAttribute: key => attrs[key] ?? null };
  const snapshot = page.invoke(inspectForm);
  attrs.action = '/replaced';
  assert.equal(page.invoke(checkFormBindings, snapshot).attached, false);
  assert.equal(page.buttons[0].clicks, 0);
});

test('reading an application and toolbar access each prepare answers, allowing a configured key', async () => {
  const fixture = await backgroundFixture();
  assert.equal(fixture.calls.filter(([op]) => op === 'forms_prepare').length, 1);
  assert.equal(fixture.calls.find(([op]) => op === 'forms_prepare')[1].useApi, true);
  await fixture.toolbar(7);
  assert.equal(fixture.calls.filter(([op]) => op === 'forms_prepare').length, 2);
  assert.equal(fixture.state().error, '');
});

test('login and newsletter forms are inspected without dispatching paid preparation', async () => {
  for (const title of ['Sign in to Careers', 'Newsletter signup', 'Create an account', 'Contact us']) {
    const page = pastePage(); page.context.document.title = title;
    const fixture = await backgroundFixture(page);
    assert.equal(fixture.calls.some(([op]) => op === 'forms_prepare'), false, title);
    assert.ok(fixture.state().form);
    assert.equal(fixture.state().prepared, null);
  }
});

test('one pending automatic preparation blocks duplicate work and cancellation discards late values', async () => {
  const fixture = await backgroundFixture();
  let release;
  fixture.prepare(() => new Promise(resolve => { release = resolve; }));
  const pending = fixture.act({ action: 'detect', payload: { tabId: 7 } });
  await tick();
  assert.equal(fixture.state().busy, 'prepare');
  await fixture.toolbar(7);
  assert.equal(fixture.calls.filter(([op]) => op === 'forms_prepare').length, 2);
  await fixture.act({ action: 'cancel' });
  release({ formId: 'late', snapshot: 'late', fields: [] });
  await pending;
  assert.equal(fixture.state().prepared, null);
  assert.equal(fixture.calls.filter(([op]) => op === 'forms_cancel').length, 1);
});

// The owner's missing questions alongside a prepared contact field.
function missingPage() {
  const page = pastePage(), Input = page.context.HTMLInputElement;
  page.controls.push(new Input('What is your current notice period?'), new Input('How did you hear about this job?'));
  return page;
}
const missingIds = fixture => Object.fromEntries(fixture.state().form.fields.map(field => [field.label, field.id]));

test('a panel answer binds the prepared snapshot, becomes ready to paste and keeps the application context', async () => {
  const fixture = await backgroundFixture(missingPage(), { application: { applicationId: 'application:synthetic', contextFingerprint: 'context:before' } });
  const ids = missingIds(fixture), notice = ids['What is your current notice period?'];
  assert.deepEqual(plain(fixture.state().prepared.unresolved.map(item => item.id)), [notice, ids['How did you hear about this job?']]);
  fixture.applicationStatus(async () => applicationMetadata({ applicationId: 'application:synthetic', contextFingerprint: 'context:after' }));
  await fixture.act({ action: 'answer-save', payload: { fieldId: notice, value: 'One month' } });
  const payload = fixture.calls.find(([op]) => op === 'forms_answer_save')[1];
  assert.deepEqual(Object.keys(payload).sort(), ['fieldId', 'formId', 'requestId', 'snapshot', 'source', 'value']);
  assert.deepEqual({ ...payload, requestId: undefined }, { fieldId: notice, formId: 'form:synthetic', snapshot: 'snapshot:synthetic', source: 'panel', value: 'One month', requestId: undefined });
  assert.equal(fixture.state().error, '');
  assert.deepEqual(plain(fixture.state().saved), { [notice]: { scope: 'future', source: 'panel' } });
  assert.deepEqual(plain(fixture.state().prepared.fields.map(field => [field.id, field.value])), [[fixture.state().prepared.fields[0].id, 'Synthetic Candidate'], [notice, 'One month']]);
  assert.equal(fixture.state().prepared.unresolved.some(item => item.id === notice), false);
  assert.equal(fixture.state().application.contextFingerprint, 'context:after', 'the re-bound context is adopted without discarding answers');
  assert.equal(fixture.calls.filter(([op]) => op === 'forms_prepare').length, 1, 'no paid or repeated preparation');
  fixture.page.focus(fixture.page.controls.find(control => control.name === 'What is your current notice period?'));
  await tick();
  assert.deepEqual(fixture.page.clipboard, ['One month']);
});

test('failed and false-success answer saves keep the answer missing', async () => {
  for (const save of [async () => { throw new Error('Storage is locked. Unlock Companion and try again.'); }, async () => ({ ok: true }), async payload => ({ fieldId: payload.fieldId, scope: 'everywhere' })]) {
    const fixture = await backgroundFixture(missingPage()); fixture.answerSave(save);
    const notice = missingIds(fixture)['What is your current notice period?'];
    await fixture.act({ action: 'answer-save', payload: { fieldId: notice, value: 'One month' } });
    assert.ok(fixture.state().error);
    assert.deepEqual(plain(fixture.state().saved), {});
    assert.ok(fixture.state().prepared.unresolved.some(item => item.id === notice));
  }
});

test('panel answers for fields that cannot be added never reach Companion', async () => {
  const fixture = await backgroundFixture(missingPage());
  const prepared = fixture.state().prepared.fields[0].id;
  for (const payload of [{ fieldId: prepared, value: 'Changed' }, { fieldId: 'gender', value: 'private' }, { fieldId: missingIds(fixture)['How did you hear about this job?'], value: '  ' }]) {
    await fixture.act({ action: 'answer-save', payload });
    assert.ok(fixture.state().error);
  }
  await fixture.act({ action: 'answer-undo', payload: { fieldId: missingIds(fixture)['How did you hear about this job?'] } });
  assert.match(fixture.state().error, /no saved answer/);
  assert.equal(fixture.calls.some(([op]) => op === 'forms_answer_save'), false);
});

test('page typing reports only missing snapshot fields on change, and Undo removes a reusable save', async () => {
  const fixture = await backgroundFixture(missingPage()), ids = missingIds(fixture);
  fixture.answerSave(async payload => ({ fieldId: payload.fieldId, scope: payload.fieldId === ids['How did you hear about this job?'] ? 'none' : 'future' }));
  const control = label => fixture.page.controls.find(item => item.name === label);
  const saves = () => fixture.calls.filter(([op]) => op === 'forms_answer_save').map(([, payload]) => [payload.fieldId, payload.value, payload.source]);
  const notice = control('What is your current notice period?');
  notice.value = 'One mon'; fixture.page.listeners.input({ target: notice, isTrusted: true });
  assert.equal(fixture.page.messages.some(message => message.action === 'answer-captured'), false, 'never per keystroke');
  notice.value = ' One month '; fixture.page.listeners.change({ target: notice, isTrusted: true });
  control('Full name').value = 'Typed over a prepared answer'; fixture.page.listeners.change({ target: control('Full name'), isTrusted: true });
  control('Gender').value = 'private'; fixture.page.listeners.change({ target: control('Gender'), isTrusted: true });
  control('How did you hear about this job?').value = 'A friend'; fixture.page.listeners.change({ target: control('How did you hear about this job?'), isTrusted: false });
  await tick(); await tick();
  assert.deepEqual(saves(), [[ids['What is your current notice period?'], 'One month', 'page']]);
  fixture.page.listeners.change({ target: control('How did you hear about this job?'), isTrusted: true });
  await tick(); await tick();
  assert.deepEqual(plain(fixture.state().saved), { [ids['What is your current notice period?']]: { scope: 'future', source: 'page' }, [ids['How did you hear about this job?']]: { scope: 'none', source: 'page' } });
  assert.equal(fixture.state().prepared.fields.length, 1, 'page-typed answers are already filled, not staged for paste');
  await fixture.act({ action: 'answer-undo', payload: { fieldId: ids['What is your current notice period?'] } });
  assert.deepEqual(saves().at(-1), [ids['What is your current notice period?'], null, 'page']);
  assert.deepEqual(plain(fixture.state().saved[ids['What is your current notice period?']]), { scope: 'none', source: 'page' });
});

test('placeholder prompts are replaced by the visible question before the control', () => {
  const page = pageContext(), [control, other] = page.controls;
  const question = { tagName: 'DIV', textContent: 'Where are you based?', cloneNode() { return this; }, querySelector: () => null };
  control.attrs['aria-label'] = 'Start typing...'; control.previousElementSibling = question;
  other.attrs['aria-label'] = 'Select...'; other.previousElementSibling = page.controls[0];
  const labels = Array.from(page.invoke(inspectForm).fields, field => field.label);
  assert.deepEqual(labels, ['Where are you based?', 'Select...']);
  control.attrs['aria-label'] = 'Full name'; assert.equal(page.invoke(inspectForm).fields[0].label, 'Full name');
});

test('machine-name fallback labels use friendly final path segments', () => {
  const page = pageContext(), control = page.controls[0];
  control.name = 'application_form[application][preferred_name]';
  control.getAttribute = key => key === 'aria-label' ? null : control.attrs[key] ?? null;
  assert.equal(page.invoke(inspectForm).fields[0].label, 'preferred name');
});

test('custom comboboxes remain manual and role changes invalidate inspected bindings', () => {
  for (const attrs of [{ role: 'combobox' }, { 'aria-autocomplete': 'list' }, { 'aria-autocomplete': 'both' }]) {
    const page = pageContext(), control = page.controls[0];
    Object.assign(control.attrs, attrs);
    const snapshot = page.invoke(inspectForm), field = snapshot.fields[0];
    assert.equal(field.manualOnly, true);
    assert.equal(control.value, '');
  }
  const changed = pageContext(), snapshot = changed.invoke(inspectForm);
  changed.controls[0].attrs.role = 'combobox';
  assert.equal(changed.invoke(checkFormBindings, snapshot).attached, false);
});

test('custom combobox focus never replaces the clipboard with a prepared value', async () => {
  const page = pastePage();
  page.controls[0].attrs.role = 'combobox';
  page.invoke(inspectForm);
  page.invoke(armSmartPaste, { session: randomUUID() });
  page.respond(() => ({ value: 'London' }));
  page.focus(page.controls[0]);
  await tick();
  assert.deepEqual(page.clipboard, []);
  assert.equal(page.messages.some(message => message.action === 'paste-value'), false);
});

test('a page script armed without capture fields reports nothing', () => {
  const page = pastePage();
  page.invoke(inspectForm);
  page.invoke(armSmartPaste, { session: randomUUID() });
  page.controls[0].value = 'Typed'; page.listeners.change({ target: page.controls[0], isTrusted: true });
  assert.equal(page.messages.length, 0);
});

test('application metadata projection never exposes files, prompts, credentials or prose', () => {
  const view = applicationView(applicationMetadata({
    documents: [{ kind: 'cv', ready: true, label: '/private/candidate.pdf', uri: 'file:///private/candidate.pdf', bytes: 'private CV' }],
    writing: [{ fieldId: 'why', label: 'Why this role?', ready: true, value: 'Private narrative' }],
    introduction: { ready: true, paragraphs: ['Private introduction'], path: '/private/letter.pdf' },
    credentials: 'secret-key', prompt: 'private prompt', preferredHost: 'codex', state: 'drafts',
  }));
  assert.equal(view.documents[0].label, 'CV');
  assert.equal(view.documents[0].ready, true);
  assert.equal(view.documents[1].ready, false);
  assert.equal(view.preferredHost, 'codex');
  assert.deepEqual(view.introduction, { ready: true });
  assert.doesNotMatch(JSON.stringify(view), /private|Private|secret-key|file:/);
  assert.equal(applicationView(applicationMetadata({ jobUrl: 'file:///private/candidate.pdf' })).jobUrl, null);
  assert.throws(() => applicationView({ state: 'ready' }), /Read page/);
});

test('native application operations are internal and do not expand website permissions', async () => {
  const port = fakePort(), client = createNativeClient({ host: 'synthetic', connect: () => port });
  for (const op of ['application_resolve', 'application_status', 'application_prepare', 'application_document', 'application_open_ad', 'application_host', 'application_copy_intro']) {
    const pending = client.request(op, { bindingId: 'binding:synthetic' });
    assert.equal(port.sent.at(-1).op, op);
    port.onMessage.emit({ version: 1, id: port.sent.at(-1).id, ok: true, result: { accepted: true } });
    assert.deepEqual(await pending, { accepted: true });
    assert.throws(() => safeDeviceRequest(request(op), origin), /not permitted/);
  }
});

test('reading resolves exact context before preparation and one Prepare hands it to the chosen app', async () => {
  const context = { jobLinks: [{ url: 'https://jobs.example.test/role', title: 'Read job description' }] };
  const fixture = await backgroundFixture(pastePage(), {
    context, application: { state: 'needs_job', preferredHost: 'codex' },
    prepare: () => { throw new Error('Configure the Decisions API to map these fields.'); },
  });
  assert.deepEqual(fixture.injections.filter(name => ['inspectForm', 'captureJobs', 'captureApplicationContext'].includes(name)), ['inspectForm', 'captureJobs', 'captureApplicationContext']);
  const operations = fixture.calls.map(([op]) => op);
  assert.ok(operations.indexOf('application_resolve') < operations.indexOf('forms_prepare'));
  assert.deepEqual(fixture.calls.find(([op]) => op === 'application_resolve')[1].context, context);
  assert.equal(fixture.state().application.state, 'needs_job');
  assert.equal(fixture.state().applicationHost, 'codex');
  assert.match(fixture.state().error, /Decisions API/);
  await fixture.act({ action: 'application-prepare', payload: { host: 'codex', path: '/must-not-forward', prompt: 'must-not-forward' } });
  assert.deepEqual(fixture.calls.at(-1), ['application_prepare', { bindingId: 'binding:synthetic', host: 'codex' }]);
  assert.equal(fixture.state().application.state, 'needs_job', 'launch is not document preparation');
  assert.ok(fixture.state().notice.includes('Send'));
  assert.doesNotMatch(fixture.state().notice, /generating|ready/i);
});

test('web-led host launch is single-flight and polling never launches a second host', async () => {
  const fixture = await backgroundFixture(), panel = fixture.connectPanel();
  let release;
  fixture.launchApplication(() => new Promise(resolve => { release = resolve; }));
  const launch = fixture.act({ action: 'application-prepare', payload: { host: 'claude' } });
  await fixture.act({ action: 'application-prepare', payload: { host: 'claude' } });
  assert.equal(fixture.calls.filter(([op]) => op === 'application_prepare').length, 1);
  const waiting = applicationMetadata({ handoff: { host: 'claude', state: 'awaiting_agent', requiresSend: true } });
  fixture.application(waiting); release({ ...waiting, opened: true, requiresSend: true }); await launch;
  await fixture.poll(); await fixture.poll();
  assert.equal(fixture.calls.filter(([op]) => op === 'application_prepare').length, 1);
  assert.equal(fixture.state().application.documents.some(doc => doc.ready), false);
  assert.equal(fixture.state().application.writing.some(field => field.ready), false);
  panel.disconnect();
});

test('agent-led current packages resolve automatically without launching or re-preparing on every poll', async () => {
  const ready = applicationMetadata({ state: 'ready', answerVersion: 'version-1', documents: [{ kind: 'cv', ready: true }, { kind: 'cover_letter', ready: true }], writing: [{ fieldId: 'why', label: 'Why?', ready: true }] });
  const fixture = await backgroundFixture(pastePage(), { application: ready }), panel = fixture.connectPanel();
  assert.equal(fixture.state().application.documents.every(doc => doc.ready), true);
  for (let n = 0; n < 3; n++) await fixture.poll();
  assert.equal(fixture.calls.filter(([op]) => op === 'forms_prepare').length, 1);
  assert.equal(fixture.calls.some(([op]) => op === 'application_prepare'), false);
  await fixture.act({ action: 'application-document', payload: { kind: 'cover_letter', action: 'reveal', path: '/not-accepted' } });
  assert.deepEqual(fixture.calls.at(-1), ['application_document', { bindingId: ready.bindingId, kind: 'cover_letter', action: 'reveal' }]);
  panel.disconnect();
});

test('new ready answer versions trigger one approved refresh and metadata-only changes trigger none', async () => {
  const fixture = await backgroundFixture(), panel = fixture.connectPanel();
  const ready = applicationMetadata({ state: 'ready', answerVersion: 'version-1', writing: [{ fieldId: 'why', label: 'Why?', ready: true }] });
  fixture.application(ready); await fixture.poll();
  assert.equal(fixture.calls.filter(([op]) => op === 'forms_prepare').length, 2);
  assert.equal(fixture.state().applicationAnswersPending, false);
  assert.equal(fixture.state().answersStale, false);
  fixture.application({ ...ready, documents: [{ kind: 'cv', ready: true }, { kind: 'cover_letter', ready: true }] });
  await fixture.poll(); await fixture.poll();
  assert.equal(fixture.state().application.documents.every(doc => doc.ready), true);
  assert.equal(fixture.calls.filter(([op]) => op === 'forms_prepare').length, 2);
  fixture.application({ ...ready, answerVersion: 'version-2' }); await fixture.poll();
  assert.equal(fixture.calls.filter(([op]) => op === 'forms_prepare').length, 3);
  panel.disconnect();
});

test('agent answers saved while a question or document is still missing refresh once; a changed context waits for the agent', async () => {
  const fixture = await backgroundFixture(), panel = fixture.connectPanel();
  const drafts = applicationMetadata({ state: 'drafts', answerVersion: 'version-1' });
  fixture.application(drafts); await fixture.poll(); await fixture.poll();
  assert.equal(fixture.calls.filter(([op]) => op === 'forms_prepare').length, 2);
  assert.equal(fixture.state().answersStale, false);
  fixture.application({ ...drafts, state: 'needs_refresh', answerVersion: 'version-2' }); await fixture.poll();
  assert.equal(fixture.calls.filter(([op]) => op === 'forms_prepare').length, 2);
  panel.disconnect();
});

test('refused automatic refresh retains package readiness and exposes one explicit retry without a paid loop', async () => {
  const fixture = await backgroundFixture(pastePage(), { application: { applicationId: 'application:synthetic' } }), panel = fixture.connectPanel();
  fixture.prepare(() => { throw new Error('Approval was cancelled.'); });
  fixture.application(applicationMetadata({ state: 'ready', answerVersion: 'version-1' }));
  await fixture.poll(); await fixture.poll(); await fixture.poll();
  assert.equal(fixture.calls.filter(([op]) => op === 'forms_prepare').length, 2);
  assert.equal(fixture.state().application.state, 'ready');
  assert.equal(fixture.state().applicationAnswersPending, true);
  assert.equal(fixture.state().answersStale, true);
  assert.match(fixture.state().error, /cancelled/);
  assert.deepEqual(fixture.page.clipboard, []);
  await fixture.act({ action: 'application-answers' });
  assert.equal(fixture.calls.filter(([op]) => op === 'forms_prepare').length, 3, 'an explicit retry is allowed');
  panel.disconnect();
});

test('saved answer updates preserve reviewed edits and require explicit replacement', async () => {
  const fixture = await backgroundFixture(pastePage(), { application: { applicationId: 'application:synthetic' } }), panel = fixture.connectPanel(), field = fixture.state().prepared.fields[0];
  await fixture.act({ action: 'edit', payload: { identity: reviewIdentity(fixture.state()), snapshot: fixture.state().prepared.snapshot, edits: { [field.id]: 'My unsaved edit' }, selected: [field.id] } });
  fixture.application(applicationMetadata({ state: 'ready', answerVersion: 'version-1' }));
  await fixture.poll(); await fixture.poll();
  assert.equal(fixture.calls.filter(([op]) => op === 'forms_prepare').length, 1);
  assert.equal(fixture.state().edits[field.id], 'My unsaved edit');
  assert.equal(fixture.state().applicationAnswersPending, true);
  assert.equal(fixture.state().answersStale, true);
  fixture.page.focus(fixture.page.controls[0]);
  await tick();
  assert.deepEqual(fixture.page.clipboard, []);
  assert.equal(fixture.page.controls[0].value, '');
  await fixture.act({ action: 'application-answers' });
  assert.equal(fixture.state().answersStale, false);
  assert.equal(fixture.calls.filter(([op]) => op === 'forms_prepare').length, 2);
  panel.disconnect();
});

test('refresh rechecks inspected controls and never restores stale or protected page bindings', async () => {
  const fixture = await backgroundFixture(), panel = fixture.connectPanel();
  fixture.page.controls[0].type = 'password';
  fixture.application(applicationMetadata({ state: 'ready', answerVersion: 'version-1' }));
  await fixture.poll();
  assert.equal(fixture.calls.filter(([op]) => op === 'forms_prepare').length, 1);
  assert.equal(fixture.state().application, null);
  assert.equal(fixture.state().prepared, null);
  assert.match(fixture.state().notice, /page changed/);
  assert.equal(fixture.page.controls[0].value, '');
  panel.disconnect();
});

test('application polling requires a connected panel, is single-flight and discards disconnected results', async () => {
  const fixture = await backgroundFixture();
  await fixture.poll();
  assert.equal(fixture.calls.some(([op]) => op === 'application_status'), false);
  assert.equal(fixture.scheduledPolls, 0);
  const panel = fixture.connectPanel();
  assert.equal(fixture.scheduledPolls, 1);
  let release;
  fixture.applicationStatus(() => new Promise(resolve => { release = resolve; }));
  const pending = fixture.poll();
  await fixture.poll();
  assert.equal(fixture.calls.filter(([op]) => op === 'application_status').length, 1);
  panel.disconnect();
  assert.equal(fixture.scheduledPolls, 0);
  release(applicationMetadata({ state: 'ready', answerVersion: 'version-1' })); await pending;
  assert.equal(fixture.state().application.state, 'needs_documents');
  assert.equal(fixture.calls.filter(([op]) => op === 'forms_prepare').length, 1);
});

test('navigation, tab switches, tab closure and native disconnect erase application and clipboard context', async () => {
  for (const leave of [fixture => fixture.activate(9), fixture => fixture.updateTab(7, { status: 'loading' }), fixture => fixture.updateTab(7, { url: 'https://unrelated.example/apply' }), fixture => fixture.removeTab(7), fixture => fixture.disconnect()]) {
    const fixture = await backgroundFixture(), panel = fixture.connectPanel();
    let release;
    fixture.applicationStatus(() => new Promise(resolve => { release = resolve; }));
    const pending = fixture.poll();
    leave(fixture);
    assert.equal(fixture.state().application, null);
    assert.equal(fixture.state().prepared, null);
    release(applicationMetadata({ state: 'ready', answerVersion: 'wrong-tab' })); await pending;
    assert.equal(fixture.state().application, null, 'late metadata cannot repopulate a previous tab');
    assert.equal(fixture.scheduledPolls, 0);
    panel.disconnect();
  }
});

test('host selection survives metadata updates and original-ad actions accept no panel URL', async () => {
  const fixture = await backgroundFixture(), panel = fixture.connectPanel();
  await fixture.act({ action: 'application-host', payload: { host: 'codex' } });
  fixture.application(applicationMetadata({ preferredHost: 'claude', state: 'needs_job' }));
  await fixture.poll();
  assert.equal(fixture.state().applicationHost, 'codex', 'polling does not undo an explicit choice');
  await fixture.act({ action: 'application-open-ad', payload: { url: 'https://wrong.example' } });
  assert.deepEqual(fixture.calls.at(-1), ['application_open_ad', { bindingId: 'binding:synthetic' }]);
  await fixture.act({ action: 'application-document', payload: { kind: 'cv', action: 'open' } });
  assert.equal(fixture.calls.some(([op]) => op === 'application_document'), false);
  assert.match(fixture.state().error, /not ready/);
  panel.disconnect();
});

test('closing the panel cancels a pending automatic native approval and discards late values', async () => {
  const fixture = await backgroundFixture(), panel = fixture.connectPanel();
  let release;
  fixture.prepare(() => new Promise(resolve => { release = resolve; }));
  fixture.application(applicationMetadata({ state: 'ready', answerVersion: 'version-1' }));
  const pending = fixture.poll();
  await tick();
  assert.equal(fixture.state().busy, 'prepare');
  panel.disconnect();
  assert.equal(fixture.calls.filter(([op]) => op === 'forms_cancel').length, 1);
  release({ formId: 'late', fields: [] }); await pending;
  assert.notEqual(fixture.state().prepared?.formId, 'late');
  assert.equal(fixture.state().applicationAnswersPending, true);
  assert.equal(fixture.scheduledPolls, 0);
});

test('automatic status reads have a fixed budget and never consume paid preparation repeatedly', async () => {
  const fixture = await backgroundFixture(), panel = fixture.connectPanel();
  for (let count = 0; count < 245; count++) await fixture.poll();
  assert.equal(fixture.calls.filter(([op]) => op === 'application_status').length, 240);
  assert.equal(fixture.calls.filter(([op]) => op === 'forms_prepare').length, 1);
  assert.match(fixture.state().applicationNotice, /Automatic updates paused/);
  panel.disconnect();
});

test('an exact saved application binding prepares an otherwise unnamed form but never a login', async () => {
  for (const [title, expectedPreparations] of [['Engineer at Example', 1], ['Sign in to Careers', 0]]) {
    const page = pastePage(); page.context.document.title = title;
    const fixture = await backgroundFixture(page, { application: applicationMetadata({ state: 'ready', answerVersion: 'saved-version' }) });
    assert.equal(fixture.state().application.applicationId, 'application:synthetic');
    assert.equal(fixture.calls.filter(([op]) => op === 'forms_prepare').length, expectedPreparations);
    assert.equal(fixture.calls.some(([op]) => op === 'application_prepare'), false);
  }
});

test('native errors retain actionable codes without confusing account requirements with disconnection', async () => {
  const port = fakePort(), client = createNativeClient({ host: 'synthetic', connect: () => port });
  for (const code of ['PAIRING_REQUIRED', 'LOCAL_LOCKED', 'FORM_CONTEXT_CHANGED']) {
    const pending = client.request('forms_prepare', {});
    port.onMessage.emit({ version: 1, id: port.sent.at(-1).id, ok: false, error: { code, message: 'Recover this operation.' } });
    await assert.rejects(pending, { code });
    assert.equal(client.connected(), true);
  }
  const unavailable = createNativeClient({ host: 'synthetic', connect: () => { throw new Error('Missing native host'); } });
  assert.throws(() => unavailable.request('status', {}), { code: 'COMPANION_UNAVAILABLE' });
});

test('reading exposes only actual prerequisite facts and does not require account pairing', async () => {
  for (const firefox of [false, true]) {
    const fixture = await backgroundFixture(pastePage(), { firefox, hasCv: false });
    assert.equal(fixture.state().companion.paired, false);
    assert.equal(fixture.state().companion.hasCv, false);
    assert.equal(fixture.state().companion.locked, false);
    assert.equal(fixture.state().companion.workflowVersion, 2);
    assert.equal(fixture.state().companion.decisionApiConfigured, false);
    assert.ok(fixture.state().prepared);
    assert.equal(fixture.state().errorCode, null);
    assert.doesNotMatch(JSON.stringify(fixture.state()), /must not reach panel/);
    fixture.disconnect();
    assert.equal(fixture.state().errorCode, 'COMPANION_UNAVAILABLE');
    assert.equal(fixture.state().companion, null);
    await fixture.act({ action: 'detect', payload: { tabId: 7 } });
    assert.equal(fixture.state().errorCode, null);
    assert.ok(fixture.state().prepared);
    fixture.status(async () => { throw Object.assign(new Error('Connect this account.'), { code: 'PAIRING_REQUIRED' }); });
    await fixture.act({ action: 'detect', payload: { tabId: 7 } });
    assert.equal(fixture.state().errorCode, 'PAIRING_REQUIRED');
  }
});

test('installation recovery opens downloads without asserting Companion installation', async () => {
  const fixture = await backgroundFixture();
  fixture.disconnect();
  await fixture.act({ action: 'install' });
  assert.deepEqual(plain(fixture.createdTabs), [{ url: new URL('/downloads', origin).href }]);
  assert.equal(fixture.state().companion, null);
  assert.equal(fixture.state().prepared, null);
});

test('permission, unsupported page and actual script failure remain distinct in both browsers', async () => {
  for (const firefox of [false, true]) {
    let url = 'https://example.test/apply', cause = new Error('Missing host permission');
    const inject = createPageAccess({
      ...(firefox ? { sidebarAction: {} } : { sidePanel: { setPanelBehavior: async () => {} } }),
      tabs: { get: async () => ({ url }) },
      scripting: { executeScript: async () => { throw cause; } },
      onError: assert.fail,
    });
    await assert.rejects(inject(7, inspectForm), { code: 'PAGE_PERMISSION_REQUIRED' });
    url = firefox ? 'about:addons' : 'chrome://extensions';
    await assert.rejects(inject(7, inspectForm), { code: 'PAGE_UNSUPPORTED' });
    url = 'https://example.test/apply'; cause = new Error('Script crashed');
    await assert.rejects(inject(7, inspectForm), { code: 'PAGE_READ_FAILED' });
  }
});

function applicationContextFixture({ title = 'Market prices', body = 'Prices and market news.', metadata = [], apply = false, description = false, links = [] } = {}) {
  const main = { innerHTML: body };
  const document = {
    title, createElement: inertTemplate,
    querySelector(selector) {
      if (selector === 'h1') return { textContent: title };
      if (selector.includes('job-description')) return description ? main : null;
      if (selector === 'main,article,[role="main"]') return main;
      return null;
    },
    querySelectorAll(selector) {
      if (selector.startsWith('script')) return metadata.map(value => ({ textContent: JSON.stringify(value) }));
      if (selector === 'a[href]') return links.map(link => ({ textContent: link.title, getAttribute: () => link.url }));
      if (selector.startsWith('a[href],')) return apply ? [{ textContent: 'Apply now' }] : [];
      return [];
    },
  };
  const context = vm.createContext({ URL, document, location: { href: 'https://example.test/jobs/engineer' }, AbortController, setTimeout, clearTimeout });
  return () => vm.runInContext(`(${captureApplicationContext.toString()})()`, context);
}

test('generic articles and price pages never become original adverts from their main text or title', async () => {
  for (const value of [
    { title: 'Asset price', body: 'Market cap, trading volume, historical prices and news.' },
    { title: 'Software engineer careers', body: 'An article about software engineering careers and the latest industry news.' },
    { title: 'Job market report', body: 'Salary and compensation trends. Requirements vary by industry. Responsibilities are changing.' },
    { title: 'Apply for newsletter', body: 'Read our daily market news.', apply: true },
  ]) {
    const context = await applicationContextFixture(value)();
    assert.equal(context.original, undefined, value.title);
    assert.deepEqual(plain(context.jobLinks), []);
  }
});

test('genuine generic, selector-backed and structured adverts retain exact useful context', async () => {
  const body = 'Responsibilities: build browser tools. Requirements: JavaScript experience. Benefits: paid leave.';
  const generic = await applicationContextFixture({ title: 'Browser engineer', body, apply: true })();
  assert.equal(generic.original.title, 'Browser engineer');
  assert.equal(generic.original.text, body);
  assert.equal(generic.original.complete, false);
  const selector = await applicationContextFixture({ title: 'Engineer', body: 'Original role details.', description: true })();
  assert.equal(selector.original.text, 'Original role details.');
  const structured = await applicationContextFixture({ metadata: [{ '@type': 'JobPosting', title: 'Platform engineer', url: 'https://example.test/jobs/platform', description: body }] })();
  assert.equal(structured.original.url, 'https://example.test/jobs/platform');
  assert.equal(structured.original.complete, true);
  const listing = await applicationContextFixture({ body, apply: true, metadata: [
    { '@type': 'JobPosting', title: 'First', description: body }, { '@type': 'JobPosting', title: 'Second', description: body },
  ] })();
  assert.equal(listing.original, undefined, 'multiple structured adverts cannot become one generic original');
});

test('a non-job reading surface does not connect, resolve an application or launch inference', async () => {
  const page = pastePage(); page.controls.splice(0); page.buttons.splice(0); page.context.document.title = 'Asset price';
  const fixture = await backgroundFixture(page);
  assert.equal(fixture.state().pageKind, 'none');
  assert.deepEqual(fixture.calls, []);
  await fixture.act({ action: 'application-prepare' });
  assert.equal(fixture.calls.length, 0);
  assert.equal(fixture.state().application, null);
});

test('a generic advert outside the catalogue needs only one Prepare and exact original context', async () => {
  const page = pastePage(); page.controls.splice(0); page.buttons.splice(0);
  const original = { url: page.context.location.href, title: 'Independent engineer', text: 'Responsibilities and requirements for this exact role.', complete: false };
  const fixture = await backgroundFixture(page, { context: { original, jobLinks: [], diagnostic: 'not a native field' }, preferredHost: 'claude' });
  assert.equal(fixture.state().pageKind, 'job');
  const resolve = fixture.calls.find(([op]) => op === 'application_resolve')[1];
  assert.deepEqual(resolve.jobs, [{ title: original.title, url: original.url, description: original.text, complete: false }]);
  assert.equal(Object.hasOwn(resolve.context, 'diagnostic'), false);
  assert.equal(fixture.calls.some(([op]) => op === 'application_prepare'), false);
  await fixture.act({ action: 'application-prepare' });
  assert.deepEqual(fixture.calls.filter(([op]) => op === 'application_prepare'), [['application_prepare', { bindingId: 'binding:synthetic', host: 'claude' }]]);
  assert.equal(fixture.state().application.handoff.state, 'awaiting_agent');
});

test('partial application forms prepare deterministic answers without an account or API key', async () => {
  const page = pastePage(); page.controls.splice(1); page.context.document.title = 'Apply for engineer';
  const fixture = await backgroundFixture(page);
  assert.equal(fixture.state().pageKind, 'application');
  assert.ok(fixture.state().prepared);
  assert.equal(fixture.state().companion.paired, false);
  assert.equal(fixture.calls.find(([op]) => op === 'forms_prepare')[1].useApi, true);
  await fixture.act({ action: 'prepare-saved' });
  assert.equal(fixture.calls.filter(([op]) => op === 'forms_prepare').length, 2);
  assert.equal(fixture.calls.at(-1)[1].useApi, false);
  assert.equal(fixture.calls.some(([op]) => op.includes('settings') || op === 'application_prepare'), false);
});

test('listings never resolve the first job and open only an exact current candidate', async () => {
  const jobs = [
    { title: 'First role', url: 'https://jobs.example.test/jobs/one', complete: false },
    { title: 'Second role', url: 'https://jobs.example.test/jobs/two', complete: false },
  ];
  const fixture = await backgroundFixture(pastePage(), { jobs });
  assert.equal(fixture.state().pageKind, 'listing');
  assert.equal(fixture.calls.some(([op]) => op === 'application_resolve' || op === 'forms_prepare'), false);
  await fixture.act({ action: 'application-prepare' });
  assert.equal(fixture.calls.some(([op]) => op === 'application_prepare'), false);
  await fixture.act({ action: 'open-job', payload: { url: 'https://unrelated.example/' } });
  assert.deepEqual(fixture.createdTabs, []);
  await fixture.act({ action: 'open-job', payload: { url: jobs[1].url } });
  assert.deepEqual(plain(fixture.createdTabs), [{ url: jobs[1].url }]);
});

test('a complete single posting whose declared URL differs from the tab is still the current job', async () => {
  const page = pastePage(); page.controls.splice(0);
  const declared = 'https://jobs.example.test/jobs/canonical-role';
  const fixture = await backgroundFixture(page, { jobs: [{ title: 'Role', url: declared, complete: true }],
    context: { original: { url: declared, title: 'Role', text: 'Full description', complete: true }, jobLinks: [] } });
  assert.notEqual(fixture.state().pageKind, 'listing');
  assert.ok(fixture.calls.some(([op]) => op === 'application_resolve'));
});

test('persisted AI choice survives another read and is used by Prepare without launching on selection', async () => {
  const fixture = await backgroundFixture();
  await fixture.act({ action: 'application-host', payload: { host: 'claude', prompt: 'not forwarded' } });
  assert.deepEqual(fixture.calls.at(-1), ['application_host', { host: 'claude' }]);
  assert.equal(fixture.calls.some(([op]) => op === 'application_prepare'), false);
  await fixture.toolbar(7);
  assert.equal(fixture.state().applicationHost, 'claude');
  await fixture.act({ action: 'application-prepare' });
  assert.deepEqual(fixture.calls.at(-1), ['application_prepare', { bindingId: 'binding:synthetic', host: 'claude' }]);
});

test('ready packages are reused and copying introduction requires a confirmed current receipt', async () => {
  const fixture = await backgroundFixture(pastePage(), { application: { state: 'ready', answerVersion: 'v1', introduction: { ready: true } } });
  await fixture.act({ action: 'application-prepare' });
  assert.equal(fixture.calls.some(([op]) => op === 'application_prepare'), false);
  await fixture.act({ action: 'copy-intro', payload: { text: 'arbitrary text', path: '/arbitrary/file' } });
  assert.deepEqual(fixture.calls.at(-1), ['application_copy_intro', { bindingId: 'binding:synthetic' }]);
  assert.equal(fixture.state().notice, 'Introduction copied.');
  fixture.copyIntro(async () => ({ copied: false }));
  await fixture.act({ action: 'copy-intro' });
  assert.equal(fixture.state().notice, '');
  assert.match(fixture.state().error, /did not confirm/);
  fixture.copyIntro(async () => { throw Object.assign(new Error('The introduction changed.'), { code: 'INTRODUCTION_NOT_CURRENT' }); });
  await fixture.act({ action: 'copy-intro' });
  assert.equal(fixture.state().errorCode, 'INTRODUCTION_NOT_CURRENT');
  assert.equal(fixture.state().notice, '');
});

test('late introduction receipts cannot report success after navigation or native disconnect', async () => {
  for (const invalidate of [fixture => fixture.updateTab(7, { status: 'loading' }), fixture => fixture.disconnect()]) {
    const fixture = await backgroundFixture(pastePage(), { application: { introduction: { ready: true } } });
    let release;
    fixture.copyIntro(() => new Promise(resolve => { release = resolve; }));
    const pending = fixture.act({ action: 'copy-intro' });
    await tick();
    invalidate(fixture);
    release({ copied: true }); await pending;
    assert.notEqual(fixture.state().notice, 'Introduction copied.');
    assert.equal(fixture.state().application, null);
  }
});

test('same-document rereading and saved-answer refresh preserve manual edits and selections', async () => {
  const fixture = await backgroundFixture(), field = fixture.state().prepared.fields[0];
  await fixture.act({ action: 'edit', payload: { identity: reviewIdentity(fixture.state()), snapshot: fixture.state().prepared.snapshot, edits: { [field.id]: 'My reviewed answer' }, selected: [field.id] } });
  await fixture.toolbar(7);
  assert.equal(fixture.state().edits[field.id], 'My reviewed answer');
  assert.deepEqual(plain(fixture.state().selected), [field.id]);
  await fixture.act({ action: 'prepare-saved' });
  assert.equal(fixture.state().edits[field.id], 'My reviewed answer');
});

test('old and locked Companion states stop before unsupported application operations', async () => {
  for (const [status, code] of [
    [{ hasCv: true, execution: { state: 'ready' } }, 'COMPANION_UPDATE_REQUIRED'],
    [{ applicationWorkflowVersion: 1, execution: { state: 'locked' } }, 'LOCAL_LOCKED'],
  ]) {
    const fixture = await backgroundFixture();
    fixture.status(async () => status);
    const count = fixture.calls.length;
    await fixture.toolbar(7);
    assert.equal(fixture.state().errorCode, code);
    assert.deepEqual(fixture.calls.slice(count).map(([op]) => op), ['status']);
    assert.equal(fixture.state().prepared, null);
    assert.equal(fixture.state().application, null);
  }
});

test('ambiguous advert links remain selectable rather than binding or preparing either job', async () => {
  const jobLinks = [
    { title: 'View job description', url: 'https://jobs.example.test/jobs/one' },
    { title: 'Position details', url: 'https://jobs.example.test/jobs/two' },
  ];
  const fixture = await backgroundFixture(pastePage(), { context: { jobLinks } });
  assert.equal(fixture.state().pageKind, 'listing');
  assert.deepEqual(plain(fixture.state().jobs).map(job => job.url), jobLinks.map(link => link.url));
  assert.equal(fixture.calls.some(([op]) => op === 'application_resolve' || op === 'forms_prepare'), false);
  await fixture.act({ action: 'open-job', payload: { url: jobLinks[1].url } });
  assert.deepEqual(plain(fixture.createdTabs), [{ url: jobLinks[1].url }]);
});

test('changed controls and documents cannot launch a host or copy an introduction', async () => {
  for (const action of ['application-prepare', 'copy-intro']) {
    for (const change of [fixture => { fixture.page.controls[0].type = 'password'; }, fixture => fixture.navigate('replacement-document')]) {
      const fixture = await backgroundFixture(pastePage(), { application: { introduction: { ready: true } } });
      change(fixture);
      await fixture.act({ action });
      assert.equal(fixture.calls.some(([op]) => op === 'application_prepare' || op === 'application_copy_intro'), false);
      assert.equal(fixture.state().application, null);
      assert.equal(fixture.state().prepared, null);
      assert.match(fixture.state().notice, /page changed/);
    }
  }
});

test('failed refresh keeps reviewed edits visible but never keeps clipboard eligibility', async () => {
  const fixture = await backgroundFixture(), field = fixture.state().prepared.fields[0];
  await fixture.act({ action: 'edit', payload: { identity: reviewIdentity(fixture.state()), snapshot: fixture.state().prepared.snapshot, edits: { [field.id]: 'Keep my reviewed answer' }, selected: [field.id] } });
  fixture.prepare(async () => { throw new Error('Companion could not refresh these answers.'); });
  await fixture.toolbar(7);
  assert.equal(fixture.state().edits[field.id], 'Keep my reviewed answer');
  assert.deepEqual(plain(fixture.state().selected), [field.id]);
  assert.equal(fixture.state().answersStale, true);
  fixture.page.focus(fixture.page.controls[0]);
  await tick();
  assert.deepEqual(fixture.page.clipboard, []);
});

test('handoff notices use only the confirmed host mode and never imply active generation', async () => {
  for (const [mode, expected] of [['desktop', /click Send/], ['cli', /press Enter/], [undefined, /review your message/]]) {
    const fixture = await backgroundFixture();
    fixture.launchApplication(async () => applicationMetadata({ opened: true, requiresSend: true, ...(mode ? { mode } : {}) }));
    await fixture.act({ action: 'application-prepare' });
    assert.match(fixture.state().notice, expected);
    assert.doesNotMatch(fixture.state().notice, /generating|writing|ready/i);
    if (!mode) assert.doesNotMatch(fixture.state().notice, /click Send|press Enter/);
  }
});

test('background rejects edits from a replaced question, snapshot or application context', async () => {
  for (const change of ['signature', 'snapshot', 'context', 'missing-identity']) {
    const fixture = await backgroundFixture(), current = fixture.state(), field = current.prepared.fields[0];
    const payload = { identity: reviewIdentity(current), snapshot: current.prepared.snapshot, edits: { [field.id]: 'Old private edit' }, selected: [field.id] };
    if (change === 'signature') field.signature += ':replacement';
    if (change === 'snapshot') current.prepared.snapshot = 'replacement-snapshot';
    if (change === 'context') current.application.contextFingerprint = 'replacement-context';
    if (change === 'missing-identity') delete payload.identity;
    await fixture.act({ action: 'edit', payload });
    assert.notEqual(fixture.state().edits[field.id], 'Old private edit', change);
  }
});

test('foreign JSON-LD canonical URLs remain untrusted claims, not the captured advert location', async () => {
  for (const metadata of [
    { url: 'https://employer.example/jobs/private-application' },
    { mainEntityOfPage: { '@id': 'https://employer.example/jobs/private-application' } },
  ]) {
    const captured = await applicationContextFixture({ metadata: [{ '@type': 'JobPosting', title: 'Copied role',
      description: 'Copied public advert text.', ...metadata }] })();
    assert.equal(captured.original.url, 'https://example.test/jobs/engineer');
    assert.deepEqual(plain(captured.jobLinks), []);
  }
});
