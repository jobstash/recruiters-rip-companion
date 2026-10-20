import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import vm from 'node:vm';
import { BROWSER_IDENTITIES } from '../src/browser-identity.mjs';
import { createManifest } from '../browser-extension/manifest.mjs';
import { safeDeviceRequest, externalSenderAllowed, deviceResult, createNativeClient } from '../browser-extension/src/protocol.mjs';
import { captureJobs, inspectForm, fillForm } from '../browser-extension/src/page.mjs';
import { createPageAccess } from '../browser-extension/src/page-access.mjs';

const origin = BROWSER_IDENTITIES.production.productOrigin;
const request = (op, payload = {}) => ({ version: 1, id: randomUUID(), op, payload });
const event = () => { const listeners = []; return { addListener(fn) { listeners.push(fn); }, emit(value) { for (const fn of listeners) fn(value); } }; };
const fakePort = () => ({ onMessage: event(), onDisconnect: event(), sent: [], postMessage(message) { this.sent.push(message); }, disconnect() { this.onDisconnect.emit(); } });

test('page access relies on Chrome permission enforcement and retains document identity on fill', async () => {
  let denied = true;
  const calls = [], tab = { id: 7 };
  const inject = createPageAccess({
    sidePanel: { setPanelBehavior: async () => {} },
    tabs: { async get() { return tab; } },
    scripting: { async executeScript(options) { calls.push(options); if (denied) throw new Error('Missing host permission'); return [{ result: { filled: [], skipped: [] }, documentId: 'snapshot-document' }]; } },
    onError: error => { throw error; },
  });
  await assert.rejects(inject(7, fillForm), /toolbar icon/);
  denied = false;
  await inject(7, fillForm, [{ url: 'https://jobs.example.test/apply', fields: [] }], 'snapshot-document');
  assert.deepEqual(calls.at(-1).target, { tabId: 7, documentIds: ['snapshot-document'] });
  tab.url = 'chrome://extensions';
  await assert.rejects(inject(7, captureJobs), /HTTP or HTTPS/);
  assert.equal(calls.length, 2);
});

test('production and local identities derive distinct IDs and minimal user-triggered permissions', () => {
  for (const [mode, identity] of Object.entries(BROWSER_IDENTITIES)) {
    const derived = [...createHash('sha256').update(Buffer.from(identity.key, 'base64')).digest('hex').slice(0, 32)].map(c => String.fromCharCode(97 + parseInt(c, 16))).join('');
    assert.equal(derived, identity.extensionId);
    const manifest = createManifest(identity, '3.8.1', mode === 'local');
    assert.deepEqual(manifest.permissions, ['nativeMessaging','activeTab','scripting','sidePanel']);
    assert.equal(manifest.host_permissions, undefined);
    assert.equal(manifest.content_scripts, undefined);
    assert.equal(manifest.action.default_popup, undefined);
    assert.equal(manifest.side_panel.default_path, 'panel.html');
    assert.deepEqual(manifest.externally_connectable.matches, [`${identity.productOrigin}/*`]);
  }
  assert.notEqual(BROWSER_IDENTITIES.local.extensionId, BROWSER_IDENTITIES.production.extensionId);
  assert.notEqual(BROWSER_IDENTITIES.local.nativeHost, BROWSER_IDENTITIES.production.nativeHost);
});

test('external websites can only pair, read account connection status or open settings', () => {
  for (const op of ['status','open_settings']) assert.equal(safeDeviceRequest(request(op), origin).op, op);
  const pairing = { productOrigin: origin, pairing: { deviceId: randomUUID(), challenge: 'one-time', expiresAt: new Date(Date.now() + 60000).toISOString(), account: { id: 'synthetic', label: 'Synthetic' } } };
  assert.equal(safeDeviceRequest(request('pair', pairing), origin).op, 'pair');
  for (const op of ['capture_jobs','forms_prepare','forms_cancel','career_facts','credential_read','connect_provider']) assert.throws(() => safeDeviceRequest(request(op), origin));
  assert.throws(() => safeDeviceRequest(request('status', { apiKey: 'secret' }), origin));
  assert.throws(() => safeDeviceRequest(request('pair', { ...pairing, productOrigin: 'https://other.test' }), origin));
  const port = { name: 'recruiters-device', sender: { url: `${origin}/account`, origin, tab: { id: 1 }, frameId: 0 } };
  assert.equal(externalSenderAllowed(port, origin), true);
  assert.equal(externalSenderAllowed({ ...port, sender: { ...port.sender, frameId: 1 } }, origin), false);
  assert.equal(externalSenderAllowed({ ...port, sender: { ...port.sender, origin: 'https://other.test' } }, origin), false);
  const result = deviceResult('status', { installed: true, paired: true, deviceId: 'device', publicKey: 'public', career: { facts: ['secret'] }, credentials: 'secret', decisionApiConfigured: true, execution: { state: 'ready', private: 'secret' } });
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
    constructor(name, type = 'text', value = '') { this.name = name; this.id = name; this.type = type; this.tagName = 'INPUT'; this._value = value; this.labels = []; this.autocomplete = ''; this.required = false; this.disabled = false; this.readOnly = false; this.isConnected = true; this.maxLength = -1; this.events = []; }
    get value() { return this._value; } set value(v) { this._value = String(v); }
    get checked() { return this._checked === true; } set checked(value) { this._checked = Boolean(value); }
    getClientRects() { return [1]; }
    closest() { return null; }
    getAttribute(key) { return key === 'aria-label' ? this.name : null; }
    dispatchEvent(event) { this.events.push(event.type); }
  }
  const controls = [new Input('Full name'), new Input('Email', 'email', 'already-entered@example.test'), new Input('Password', 'password'), new Input('Social security number'), new Input('Gender'), new Input('I agree to terms'), new Input('Resume', 'file')];
  const context = vm.createContext({ URL, crypto: { randomUUID }, location: { href: 'https://jobs.example.test/application' }, document: { title: 'Application', forms: [], getElementById() { return null; }, querySelectorAll() { return controls; } }, getComputedStyle: () => ({ display: 'block', visibility: 'visible' }), HTMLInputElement: Input, HTMLSelectElement: Input, HTMLTextAreaElement: Input, Event: class { constructor(type) { this.type = type; } } });
  const invoke = (fn, request = null) => { context.request = request; return vm.runInContext(`(${fn.toString()})(request)`, context); };
  return { controls, context, invoke };
}

test('inspection excludes protected controls and never includes entered values', () => {
  const page = pageContext(), snapshot = page.invoke(inspectForm);
  assert.deepEqual(Array.from(snapshot.fields, f => f.label), ['Full name', 'Email']);
  assert.equal(snapshot.fields[1].empty, false);
  assert.equal(snapshot.fields[1].manualOnly, true);
  assert.equal(JSON.stringify(snapshot).includes('already-entered'), false);
});

test('fill validates complete snapshot before writes and never overwrites or submits', () => {
  const page = pageContext(), snapshot = page.invoke(inspectForm);
  const result = page.invoke(fillForm, { url: snapshot.url, fields: snapshot.fields.map(f => ({ ...f, value: 'Synthetic Candidate' })) });
  assert.deepEqual(Array.from(result.filled), [snapshot.fields[0].id]);
  assert.deepEqual(Array.from(result.skipped), [snapshot.fields[1].id]);
  assert.equal(page.controls[0].value, 'Synthetic Candidate');
  assert.equal(page.controls[1].value, 'already-entered@example.test');
  assert.deepEqual(page.controls[0].events, ['input','change']);
  const changed = pageContext(), old = changed.invoke(inspectForm);
  changed.controls[0].name = 'Changed field';
  assert.throws(() => changed.invoke(fillForm, { url: old.url, fields: [{ ...old.fields[0], value: 'Must not write' }] }), /form changed/);
  assert.equal(changed.controls[0].value, '');
  changed.context.location.href = 'https://jobs.example.test/other';
  assert.throws(() => changed.invoke(fillForm, { url: old.url, fields: [] }), /page changed/);
  const replaced = pageContext(), beforeReplacement = replaced.invoke(inspectForm);
  replaced.controls[0] = new replaced.context.HTMLInputElement('Full name');
  assert.throws(() => replaced.invoke(fillForm, { url: beforeReplacement.url, fields: [{ ...beforeReplacement.fields[0], value: 'Must not write' }] }), /form changed/);
  assert.equal(replaced.controls[0].value, '');
});

test('synchronous page handlers cannot turn a later reviewed control into password or consent', () => {
  for (const mutation of [control => { control.type = 'password'; }, control => { control.name = 'I agree to the privacy terms'; }]) {
    const page = pageContext(); page.controls[1].value = '';
    const snapshot = page.invoke(inspectForm);
    page.controls[0].dispatchEvent = event => { page.controls[0].events.push(event.type); if (event.type === 'input') mutation(page.controls[1]); };
    const result = page.invoke(fillForm, { url: snapshot.url, fields: snapshot.fields.map(f => ({ ...f, value: 'Synthetic answer' })) });
    assert.deepEqual(Array.from(result.filled), [snapshot.fields[0].id]);
    assert.deepEqual(Array.from(result.skipped), [snapshot.fields[1].id]);
    assert.equal(page.controls[1].value, '');
    assert.deepEqual(page.controls[1].events, []);
  }
});

function contactPage(legend = 'Preferred contact method') {
  const page = pageContext(), Input = page.context.HTMLInputElement;
  const form = { id: 'application', action: 'https://jobs.example.test/application', method: 'post' };
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

test('contact method radio groups are fillable while contact consent stays protected', () => {
  const page = contactPage(), snapshot = page.invoke(inspectForm);
  const radio = snapshot.fields.find(field => field.type === 'radio');
  assert.equal(radio.label, 'Preferred contact method');
  assert.deepEqual(Array.from(radio.options, option => option.value), ['email', 'phone']);
  const result = page.invoke(fillForm, { url: snapshot.url, fields: [{ ...radio, value: 'email' }] });
  assert.deepEqual(Array.from(result.filled), [radio.id]);
  assert.equal(page.controls[1].checked, true);
  assert.equal(page.other.checked, false);
  assert.equal(contactPage('Contact me').invoke(inspectForm).fields.some(field => field.type === 'radio'), false);
});

test('a newly populated live radio member prevents writing the reviewed cached group', () => {
  const page = contactPage(), other = page.other;
  const snapshot = page.invoke(inspectForm), radio = snapshot.fields.find(field => field.type === 'radio');
  let inserted;
  page.controls[0].dispatchEvent = event => {
    if (event.type !== 'input') return;
    inserted = page.radio('existing', 'Existing choice');
    inserted.checked = true;
    page.controls.push(inserted);
  };
  const result = page.invoke(fillForm, { url: snapshot.url, fields: [{ ...snapshot.fields[0], value: 'Synthetic Candidate' }, { ...radio, value: 'email' }] });
  assert.deepEqual(Array.from(result.filled), [snapshot.fields[0].id]);
  assert.deepEqual(Array.from(result.skipped), [radio.id]);
  assert.equal(inserted.checked, true);
  assert.equal(page.controls[1].checked, false);
  assert.equal(other.checked, false);
  assert.deepEqual(page.controls[1].events, []);
});

test('choice filling accepts only actual inspected options', () => {
  const page = pageContext(), select = page.controls[0];
  select.name = 'Work mode'; select.tagName = 'SELECT'; select.type = 'select';
  select.options = [{ value: '', label: '' }, { value: 'remote', label: 'Remote' }, { value: 'office', label: 'Office' }];
  const snapshot = page.invoke(inspectForm), field = snapshot.fields[0];
  assert.equal(field.options.length, 2);
  assert.equal(field.options.some(option => option.value === ''), false);
  const denied = page.invoke(fillForm, { url: snapshot.url, fields: [{ ...field, value: 'invented-choice' }] });
  assert.deepEqual(Array.from(denied.filled), []);
  assert.equal(select.value, '');
  const allowed = page.invoke(fillForm, { url: snapshot.url, fields: [{ ...field, value: 'remote' }] });
  assert.deepEqual(Array.from(allowed.filled), [field.id]);
  assert.equal(select.value, 'remote');
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

test('a reset or rejected control is skipped rather than reported as filled', () => {
  const page = pageContext(), snapshot = page.invoke(inspectForm);
  page.controls[0].dispatchEvent = event => { if (event.type === 'change') page.controls[0].value = ''; };
  const result = page.invoke(fillForm, { url: snapshot.url, fields: [{ ...snapshot.fields[0], value: 'Rejected answer' }] });
  assert.deepEqual(Array.from(result.filled), []);
  assert.deepEqual(Array.from(result.skipped), [snapshot.fields[0].id]);
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
