import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import vm from 'node:vm';

const script = await readFile(new URL('../ui/master-cv.js', import.meta.url), 'utf8');
const html = await readFile(new URL('../ui/index.html', import.meta.url), 'utf8');
const turn = () => new Promise(resolve => setImmediate(resolve));
function saved(overrides = {}) {
  return { identity: 'synthetic-session', revision: 4, status: 'ready',
    contact: { name: 'Example Candidate', email: 'candidate@example.invalid', phone: '+1 555 0100', location: 'Example City', linkedinUrl: 'https://linkedin.com/in/example', links: ['https://example.invalid'] },
    master: { version: 2, presentation: { template: 'classic', paper: 'A4' }, document: {
      headline: 'Engineer', summary: 'Built services.', highlights: ['Reduced outages.'],
      experience: [{ employer: 'Example', role: 'Engineer', startDate: '2020', endDate: '2024', location: 'Example City', bullets: ['Reduced outages.'] }],
      skills: [{ label: 'Engineering', items: ['Systems'] }], education: [{ institution: 'Example University', qualification: 'Degree', startDate: '2010', endDate: '2014', details: 'Engineering' }],
      languages: [{ language: 'English', proficiency: 'Fluent' }], certifications: ['Example qualification'], additional: [{ title: 'Community', items: ['Mentoring'] }],
      careerGaps: [{ activity: 'Career break', place: 'Example City', startDate: '2024', endDate: '2025', description: 'Family care' }],
    } }, ...overrides };
}

function fixture(initial = saved(), handler) {
  let remote = structuredClone(initial), active;
  const calls = [], windowListeners = new Map();
  class Element {
    constructor(tag = 'div') { this.tagName = tag.toUpperCase(); this.children = []; this.dataset = {}; this.listeners = new Map(); this.attributes = {}; this.value = ''; this.textContent = ''; this.hidden = false; this.disabled = false; }
    append(...nodes) { for (const node of nodes) { node.parentElement = this; this.children.push(node); } }
    replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
    setAttribute(key, value) { this.attributes[key] = String(value); }
    getAttribute(key) { return this.attributes[key]; }
    addEventListener(event, callback) { const listeners = this.listeners.get(event) || []; listeners.push(callback); this.listeners.set(event, listeners); }
    dispatch(type, extra = {}) { const event = { preventDefault() {}, ...extra }; for (const listener of this.listeners.get(type) || []) listener(event); return event; }
    click() { if (!this.disabled) this.dispatch('click'); }
    focus() { active = this; }
    reportValidity() { return true; }
    querySelectorAll(selector) {
      const all = this.children.flatMap(child => [child, ...child.querySelectorAll('*')]);
      if (selector === '*') return all;
      if (selector === '[data-field]') return all.filter(node => node.dataset.field);
      if (selector === '[data-add]') return all.filter(node => node.dataset.add);
      return all.filter(node => node.tagName.toLowerCase() === selector);
    }
  }
  const nodes = new Map([...html.matchAll(/id="([^"]+)"/g)].map(([, id]) => [id, new Element()]));
  const tabs = ['master', 'sources', 'facts', 'preferences'].map(kind => {
    const tab = nodes.get(`me-tab-${kind}`); tab.id = `me-tab-${kind}`; tab.dataset.careerKind = kind; return tab;
  });
  const document = { getElementById: id => nodes.get(id), querySelectorAll: () => tabs, createElement: tag => new Element(tag) };
  const window = { confirm: () => true, addEventListener: (type, listener) => windowListeners.set(type, listener), companion: {
    invoke: async (operation, input) => {
      calls.push([operation, structuredClone(input)]);
      if (handler) { const response = await handler(operation, input); if (response !== undefined) return response; }
      if (operation === 'master-cv-read') return { ok: true, result: structuredClone(remote) };
      if (operation === 'master-cv-save') {
        remote = { ...remote, revision: remote.revision + 1, contact: structuredClone(input.contact), master: { version: (remote.master?.version ?? 0) + 1, document: structuredClone(input.document), presentation: structuredClone(input.presentation) } };
        return { ok: true, result: structuredClone(remote) };
      }
      if (operation === 'master-cv-export') return { ok: true, result: { exported: true, filename: `Example CV.${input.format}` } };
      throw new Error(`Unexpected operation ${operation}`);
    },
  } };
  vm.runInNewContext(script, { window, document, structuredClone, crypto: { randomUUID } });
  const node = name => nodes.get(`master-cv-${name}`);
  const field = path => [...node('fields').querySelectorAll('[data-field]'), ...node('conflict-fields').querySelectorAll('[data-field]')].find(input => input.dataset.field === path);
  return { calls, window, tabs, nodes, node, field, get active() { return active; },
    async refresh(value = remote, state = {}) { remote = structuredClone(value); window.masterCvUI.refresh({ execution: { state: 'ready' }, hasCv: true, careerViewVersion: String(remote.revision), masterCv: { identity: remote.identity, version: remote.master?.version ?? 0, revision: remote.revision, status: remote.status }, ...state }); await turn(); },
    edit(path, value) { const input = field(path); assert.ok(input, path); input.value = value; input.dispatch(input.tagName === 'SELECT' ? 'change' : 'input'); },
    add(path) { const control = node('fields').querySelectorAll('[data-add]').find(control => control.dataset.add === path); assert.ok(control, path); control.click(); },
    async save() { node('form').dispatch('submit'); await turn(); },
    clear() { window.masterCvUI.clear(); },
  };
}

test('all authored sections and full contact are editable; saving preserves plain text and readonly breaks', async () => {
  const original = saved(), ui = fixture(original);
  await ui.refresh();
  for (const [path, value] of [['contact.name', 'Edited Candidate'], ['contact.email', 'new@example.invalid'], ['contact.phone', ''], ['contact.location', 'New City'], ['contact.linkedinUrl', 'https://linkedin.com/in/edited'], ['contact.links.0.first', 'https://edited.example.invalid'], ['document.headline', 'Senior engineer'], ['document.summary', 'Edited bio.'], ['document.highlights.0.first', 'Restored service.'], ['document.experience.0.first', 'Edited employer'], ['document.experience.0.role', 'Lead'], ['document.experience.0.startDate', '2019'], ['document.experience.0.endDate', '2025'], ['document.experience.0.location', 'Remote'], ['document.experience.0.bullets.0.first', 'Improved recovery.'], ['document.skills.0.first', 'Technical'], ['document.skills.0.items.0.first', 'Reliability'], ['document.education.0.first', 'Edited university'], ['document.education.0.details', 'Research'], ['document.languages.0.proficiency', 'Native'], ['document.certifications.0.first', 'Edited certification'], ['document.additional.0.first', 'Volunteering'], ['document.additional.0.items.0.first', 'Coaching'], ['presentation.template', 'modern'], ['presentation.paper', 'LETTER']]) ui.edit(path, value);
  assert.equal(ui.node('pdf').disabled, true);
  assert.equal(ui.field('document.careerGaps.0.first'), undefined);
  await ui.save();
  const input = ui.calls.find(([op]) => op === 'master-cv-save')[1];
  assert.equal(input.baseVersion, 2); assert.equal(input.revision, 4);
  assert.equal(input.contact.phone, null);
  assert.deepEqual(input.document.highlights, ['Restored service.']);
  assert.deepEqual(input.document.experience[0], { employer: 'Edited employer', role: 'Lead', startDate: '2019', endDate: '2025', location: 'Remote', bullets: ['Improved recovery.'] });
  assert.deepEqual(input.document.careerGaps, original.master.document.careerGaps);
  assert.deepEqual(input.presentation, { template: 'modern', paper: 'LETTER' });
  assert.equal(ui.node('save').disabled, true); assert.equal(ui.node('pdf').disabled, false);
});

test('plain entries and bullets can be added, reordered and removed', async () => {
  const ui = fixture(); await ui.refresh();
  ui.add('document.experience'); ui.edit('document.experience.1.first', 'Second employer'); ui.edit('document.experience.1.role', 'Second role');
  ui.add('document.experience.1.bullets'); ui.edit('document.experience.1.bullets.0.first', 'Second outcome.');
  ui.add('document.experience.1.bullets'); ui.edit('document.experience.1.bullets.1.first', 'First outcome.');
  const row = ui.field('document.experience.1.bullets.1.first').parentElement.parentElement;
  row.querySelectorAll('button').find(button => button.textContent === 'Move up').click();
  assert.equal(ui.field('document.experience.1.bullets.0.first').value, 'First outcome.');
  const oldRow = ui.field('document.experience.1.bullets.1.first').parentElement.parentElement;
  oldRow.querySelectorAll('button').find(button => button.textContent === 'Remove').click();
  assert.equal(ui.field('document.experience.1.bullets.1.first'), undefined);
  for (const path of ['contact.links', 'document.highlights', 'document.skills', 'document.education', 'document.languages', 'document.certifications', 'document.additional']) ui.add(path);
  for (const [path, value] of [['document.experience.1.startDate', '2025'], ['document.experience.1.endDate', 'Present'], ['contact.links.1.first', 'https://portfolio.example.invalid'], ['document.highlights.1.first', 'Mentored colleagues.'], ['document.skills.1.first', 'Leadership'], ['document.education.1.first', 'Example College'], ['document.languages.1.first', 'French'], ['document.languages.1.proficiency', 'Conversational'], ['document.certifications.1.first', 'Example certificate'], ['document.additional.1.first', 'Projects']]) ui.edit(path, value);
  ui.add('document.skills.1.items'); ui.edit('document.skills.1.items.0.first', 'Mentoring');
  ui.add('document.additional.1.items'); ui.edit('document.additional.1.items.0.first', 'Community tools');
  await ui.save();
  const input = ui.calls.find(([op]) => op === 'master-cv-save')[1];
  assert.deepEqual(input.document.experience[1], { employer: 'Second employer', role: 'Second role', location: '', startDate: '2025', endDate: 'Present', bullets: ['First outcome.'] });
  assert.deepEqual(input.document.highlights, ['Reduced outages.', 'Mentored colleagues.']);
});

test('unknown employment dates stay empty while role wording and multiline bullets remain editable', async () => {
  const ui = fixture(); await ui.refresh();
  ui.edit('document.experience.0.role', 'Software engineer / team lead');
  ui.edit('document.experience.0.startDate', '');
  ui.edit('document.experience.0.endDate', '');
  ui.edit('document.experience.0.bullets.0.first', 'Handled the outage.\nRestored service for customers.');
  assert.equal(ui.field('document.experience.0.bullets.0.first').tagName, 'TEXTAREA');
  await ui.save();
  const role = ui.calls.find(([op]) => op === 'master-cv-save')[1].document.experience[0];
  assert.equal(role.role, 'Software engineer / team lead');
  assert.equal(role.startDate, ''); assert.equal(role.endDate, '');
  assert.deepEqual(role.bullets, ['Handled the outage.\nRestored service for customers.']);
});

test('polling and delayed save acknowledgements preserve newer typing', async () => {
  const original = saved(); let release;
  const ui = fixture(original, (operation, input) => operation === 'master-cv-save' ? new Promise(resolve => { release = () => resolve({ ok: true, result: { ...original, revision: 5, contact: input.contact, master: { ...original.master, version: 3, document: input.document } } }); }) : undefined);
  await ui.refresh(); ui.edit('document.summary', 'Submitted bio.');
  const field = ui.field('document.summary'); field.focus();
  await ui.refresh(); assert.equal(ui.field('document.summary'), field);
  await ui.save(); ui.edit('document.summary', 'Typed while saving.');
  release(); await turn();
  assert.equal(ui.field('document.summary'), field);
  assert.equal(field.value, 'Typed while saving.');
  assert.equal(ui.node('save').disabled, false);
  assert.match(ui.node('status').textContent, /newer unsaved/);
});

test('save failures retain all edits and permit retry', async () => {
  let fail = true;
  const ui = fixture(saved(), operation => operation === 'master-cv-save' && fail ? { ok: false, error: { code: 'INVALID_INPUT', message: 'Enter a role title.' } } : undefined);
  await ui.refresh(); ui.edit('document.summary', 'Keep this wording.'); await ui.save();
  assert.equal(ui.field('document.summary').value, 'Keep this wording.');
  assert.match(ui.node('error').textContent, /Your edits are still here/);
  assert.equal(ui.node('save').disabled, false);
  fail = false; await ui.save(); assert.equal(ui.node('error').hidden, true);
});

test('concurrent changes require explicit section choices while keeping untouched remote sections', async () => {
  const original = saved(), ui = fixture(original); await ui.refresh(); ui.edit('document.summary', 'My bio.');
  const remote = structuredClone(original); remote.revision++; remote.master.version++; remote.master.document.summary = 'Saved bio.'; remote.contact.phone = '555 0199';
  await ui.refresh(remote);
  assert.equal(ui.field('document.summary').value, 'My bio.'); assert.equal(ui.node('save').disabled, true);
  assert.equal(ui.node('conflict').hidden, false); assert.equal(ui.node('merge').disabled, true);
  ui.edit('conflict.document.summary', 'My edits'); ui.node('merge').click();
  assert.equal(ui.field('document.summary').value, 'My bio.'); assert.equal(ui.field('contact.phone').value, '555 0199');
  await ui.save(); const input = ui.calls.filter(([op]) => op === 'master-cv-save').at(-1)[1];
  assert.equal(input.revision, remote.revision); assert.equal(input.baseVersion, remote.master.version);
});

test('revision conflicts reread without discarding edits; saved section choice is honored', async () => {
  const original = saved(); let conflict = false;
  const ui = fixture(original, operation => {
    if (operation === 'master-cv-save') { conflict = true; return { ok: false, error: { code: 'REVISION_CONFLICT', message: 'Saved work changed.' } }; }
    if (operation === 'master-cv-read' && conflict) { const remote = structuredClone(original); remote.revision++; remote.master.version++; remote.master.document.summary = 'Remote bio.'; return { ok: true, result: remote }; }
  });
  await ui.refresh(); ui.edit('document.summary', 'Local bio.'); await ui.save();
  assert.equal(ui.field('document.summary').value, 'Local bio.');
  ui.edit('conflict.document.summary', 'Saved version'); ui.node('merge').click();
  assert.equal(ui.field('document.summary').value, 'Remote bio.'); assert.equal(ui.node('save').disabled, true);
});

test('lock and identity changes clear sensitive text and invalidate delayed responses', async () => {
  const original = saved(); let release;
  const ui = fixture(original, operation => operation === 'master-cv-save' ? new Promise(resolve => { release = () => resolve({ ok: true, result: original }); }) : undefined);
  await ui.refresh(); ui.edit('document.summary', 'Private draft'); await ui.save(); ui.clear(); release(); await turn();
  assert.equal(ui.node('fields').children.length, 0); assert.equal(ui.node('conflict-fields').children.length, 0);
  assert.equal(ui.node('form').hidden, true); assert.equal(ui.node('pdf').disabled, true);
  await ui.refresh(); ui.edit('document.summary', 'Previous identity draft');
  await ui.refresh(saved({ identity: 'restored-session' }));
  assert.equal(ui.field('document.summary').value, 'Built services.');
});

test('an old read cannot repopulate the editor after a lock', async () => {
  let release;
  const ui = fixture(saved(), operation => operation === 'master-cv-read' ? new Promise(resolve => { release = () => resolve({ ok: true, result: saved() }); }) : undefined);
  await ui.refresh(); ui.clear(); release(); await turn();
  assert.equal(ui.node('fields').children.length, 0); assert.equal(ui.node('form').hidden, true);
});

test('stale masters continue onboarding without a prompt action, launch or invented progress', async () => {
  const original = saved({ status: 'stale' });
  const ui = fixture(original); await ui.refresh(original, { mcpClients: [] });
  assert.match(ui.node('readiness').textContent, /Update needed/);
  assert.match(ui.node('review').textContent, /onboarding in your current or next conversation/);
  assert.doesNotMatch(ui.node('review').textContent, /copy|paste|running|in progress|pending review/i);
  assert.equal(ui.node('prompt'), undefined);
  assert.deepEqual(ui.calls.map(([operation]) => operation), ['master-cv-read']);
  assert.equal(ui.node('pdf').disabled, true); assert.equal(ui.node('txt').disabled, true);
  ui.edit('document.summary', 'Manual draft'); await ui.save();
  assert.equal(ui.node('pdf').disabled, true);
  assert.equal(ui.field('document.summary').value, 'Manual draft');
});

test('onboarding status changes preserve manual typing and focus while keeping export unavailable', async () => {
  const original = saved(), ui = fixture(original); await ui.refresh();
  ui.edit('document.summary', 'Keep my wording.');
  const field = ui.field('document.summary'); field.focus();
  const stale = { ...original, revision: original.revision + 1, status: 'stale' };
  await ui.refresh(stale);
  assert.equal(ui.field('document.summary'), field); assert.equal(ui.active, field);
  assert.equal(field.value, 'Keep my wording.');
  assert.equal(ui.node('conflict').hidden, true); assert.equal(ui.node('save').disabled, false);
  assert.equal(ui.node('pdf').disabled, true); assert.equal(ui.node('txt').disabled, true);
  assert.match(ui.node('review').textContent, /onboarding/);
  await ui.save();
  assert.equal(ui.calls.find(([op]) => op === 'master-cv-save')[1].document.summary, 'Keep my wording.');
});

test('an incomplete draft stays editable and completes onboarding without a separate interview prompt', async () => {
  const ui = fixture(saved({ status: 'draft' })); await ui.refresh();
  assert.match(ui.node('readiness').textContent, /Draft/);
  assert.match(ui.node('review').textContent, /onboarding in your current or next conversation/);
  assert.doesNotMatch(ui.node('review').textContent, /pending review|copy|paste|running/i);
  assert.match(ui.node('export-note').textContent, /Complete the headline, bio and required role fields/);
  assert.equal(ui.node('pdf').disabled, true);
  ui.edit('document.summary', 'Completed bio.'); await ui.save();
  assert.equal(ui.field('document.summary').value, 'Completed bio.');
});

test('PDF and TXT exports are version bound and cancellation is not success', async () => {
  let cancel = false;
  const ui = fixture(saved(), operation => operation === 'master-cv-export' && cancel ? { ok: true, result: { exported: false } } : undefined);
  await ui.refresh(); ui.node('pdf').click(); await turn();
  assert.match(ui.node('status').textContent, /Exported Example CV.pdf/);
  cancel = true; ui.node('txt').click(); await turn();
  assert.equal(ui.node('status').textContent, 'Export canceled.');
  const exports = ui.calls.filter(([op]) => op === 'master-cv-export').map(([, input]) => input);
  assert.deepEqual(exports.map(({ revision, baseVersion, format }) => ({ revision, baseVersion, format })), [{ revision: 4, baseVersion: 2, format: 'pdf' }, { revision: 4, baseVersion: 2, format: 'txt' }]);
});

test('missing master joins onboarding without a special task and still permits a version-zero manual draft', async () => {
  const missing = saved({ master: null, status: 'missing' });
  const ui = fixture(missing); await ui.refresh(missing, { mcpClients: [] });
  assert.equal(ui.node('empty').hidden, false); assert.equal(ui.node('form').hidden, true);
  assert.match(ui.node('readiness').textContent, /No master CV yet/);
  assert.match(ui.node('review').textContent, /onboarding in your current or next conversation/);
  assert.doesNotMatch(ui.node('review').textContent, /0 roles|copy|paste|running|in progress/i);
  assert.equal(ui.node('prompt'), undefined);
  assert.deepEqual(ui.calls.map(([operation]) => operation), ['master-cv-read']);
  await ui.refresh(missing, { hasCv: false, mcpClients: [] });
  assert.match(ui.node('empty-note').textContent, /Import an original CV using Import CV above/);
  assert.doesNotMatch(ui.node('empty-note').textContent, /copy|paste|prompt/i);
  ui.node('start').click(); ui.edit('document.summary', 'My draft'); await ui.save();
  assert.equal(ui.calls.find(([op]) => op === 'master-cv-save')[1].baseVersion, 0);
  assert.equal(ui.field('document.summary').value, 'My draft');
});

test('Master CV tabs preserve the source, Facts and Preferences browser and keyboard navigation', async () => {
  const ui = fixture(); await ui.refresh();
  ui.tabs[0].click(); assert.equal(ui.nodes.get('master-cv').hidden, false); assert.equal(ui.nodes.get('me-saved-panes').hidden, true);
  ui.tabs[0].dispatch('keydown', { key: 'ArrowRight' });
  assert.equal(ui.active, ui.tabs[1]); assert.equal(ui.nodes.get('master-cv').hidden, true); assert.equal(ui.nodes.get('me-saved-panes').hidden, false);
  for (const tab of ui.tabs.slice(1)) { tab.click(); assert.equal(tab.getAttribute('aria-selected'), 'true'); assert.equal(ui.nodes.get('me-saved-panes').getAttribute('aria-labelledby'), tab.id); }
  ui.tabs[3].dispatch('keydown', { key: 'Home' }); assert.equal(ui.active, ui.tabs[0]);
});

test('unavailable state retains the draft but disables writes until refreshed', async () => {
  const ui = fixture(); await ui.refresh(); ui.edit('document.summary', 'Offline wording.');
  ui.window.masterCvUI.unavailable();
  assert.equal(ui.field('document.summary').value, 'Offline wording.'); assert.equal(ui.node('save').disabled, true);
  await ui.refresh(); assert.equal(ui.field('document.summary').value, 'Offline wording.'); assert.equal(ui.node('save').disabled, false);
});

test('optional address fields use profile limits and empty values remain unknown', async () => {
  const ui = fixture(); await ui.refresh();
  for (const [key, value, limit] of [['country', 'Example country', 200], ['addressLine1', '10 Example Street', 500], ['addressLine2', '', 500], ['city', 'Example town', 300], ['postalCode', 'EX10', 100]]) {
    assert.equal(ui.field(`contact.${key}`).maxLength, limit);
    ui.edit(`contact.${key}`, value);
  }
  await ui.save();
  const contact = ui.calls.find(([op]) => op === 'master-cv-save')[1].contact;
  assert.equal(contact.country, 'Example country');
  assert.equal(contact.addressLine1, '10 Example Street');
  assert.equal(contact.addressLine2, null);
  assert.equal(contact.city, 'Example town');
  assert.equal(contact.postalCode, 'EX10');
});

test('an unrelated saved revision preserves focus in a clean unchanged document', async () => {
  const original = saved(), ui = fixture(original); await ui.refresh();
  const input = ui.field('document.summary'); input.focus();
  await ui.refresh({ ...original, revision: original.revision + 1 });
  assert.equal(ui.field('document.summary'), input);
  assert.equal(ui.active, input);
  ui.edit('document.summary', 'Edited after refresh.');
  await ui.save();
  assert.equal(ui.calls.find(([op]) => op === 'master-cv-save')[1].document.summary, 'Edited after refresh.');
});

test('saving professional links trims values, removes blank rows and deduplicates', async () => {
  const ui = fixture(); await ui.refresh();
  ui.edit('contact.links.0.first', '  https://portfolio.example.invalid  ');
  ui.add('contact.links'); ui.edit('contact.links.1.first', '   ');
  ui.add('contact.links'); ui.edit('contact.links.2.first', 'https://portfolio.example.invalid');
  ui.add('contact.links'); ui.edit('contact.links.3.first', ' https://other.example.invalid ');
  await ui.save();
  const contact = ui.calls.find(([op]) => op === 'master-cv-save')[1].contact;
  assert.deepEqual(contact.links, ['https://portfolio.example.invalid', 'https://other.example.invalid']);
});

test('an incomplete draft explains which document fields to complete', async () => {
  const original = saved({ status: 'draft' }); original.master.document.headline = '';
  const ui = fixture(original); await ui.refresh();
  assert.equal(ui.node('readiness').textContent, 'Draft · Not ready to export.');
  assert.match(ui.node('review').textContent, /completes or updates the master CV as part of onboarding/);
  assert.doesNotMatch(ui.node('review').textContent, /pending review/);
  assert.match(ui.node('export-note').textContent, /Complete the headline, bio and required role fields/);
  assert.equal(ui.node('pdf').disabled, true);
});

test('incoming conflicts announce the required merge and focus it once without stealing subsequent focus', async () => {
  const original = saved(), ui = fixture(original); await ui.refresh(); ui.tabs[0].click();
  ui.edit('document.summary', 'My bio.'); ui.field('document.summary').focus();
  const remote = structuredClone(original); remote.revision++; remote.master.version++; remote.master.document.summary = 'Remote bio.';
  await ui.refresh(remote);
  assert.equal(ui.node('fields').inert, true);
  assert.equal(ui.active, ui.node('conflict-title'));
  assert.match(ui.node('status').textContent, /Review the section choices before continuing/);
  const selector = ui.field('conflict.document.summary');
  selector.focus(); ui.edit('conflict.document.summary', 'My edits');
  await ui.refresh({ ...remote, revision: remote.revision + 1 });
  assert.equal(ui.active, selector);
  assert.equal(ui.field('conflict.document.summary'), selector);
  assert.equal(selector.value, 'My edits');
  assert.equal(ui.node('merge').disabled, false);
});
