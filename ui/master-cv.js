'use strict';

// The editor owns its draft, independently of the record browser and state polling.
(() => {
  const el = name => document.getElementById(`master-cv-${name}`);
  const root = document.getElementById('master-cv');
  const tabs = [...document.querySelectorAll('#me-browser [data-career-kind]')];
  const clone = value => structuredClone(value);
  const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  // Limits mirror the profile CONTACT_FIELDS contract; address fields are optional.
  const contactFields = [
    ['name', 'Full name', 300], ['email', 'Email', 320, 'email'], ['phone', 'Phone', 100, 'tel'], ['location', 'Location', 300],
    ['country', 'Country · optional', 200], ['addressLine1', 'Address line 1 · optional', 500], ['addressLine2', 'Address line 2 · optional', 500],
    ['city', 'Town or city · optional', 300], ['postalCode', 'Postcode / ZIP code · optional', 100], ['linkedinUrl', 'LinkedIn URL', 2048, 'url'],
  ];
  const sectionNames = { headline: 'Headline', summary: 'Bio', highlights: 'Highlights', experience: 'Experience', skills: 'Skills', education: 'Education', languages: 'Languages', certifications: 'Certifications', additional: 'Additional sections', careerGaps: 'Career breaks' };
  let baseline = null, draft = null, incoming = null, identity = null, signature = '', wantedSignature = '';
  let generation = 0, reading = false, pending = '', online = false, hasCv = false, dirty = false, edits = 0, failure = '', message = '';
  let conflicts = [], choices = new Map(), conflictFocused = false;
  const blank = () => ({ headline: '', summary: '', experience: [] });
  const editable = value => ({ contact: clone(value.contact || {}), document: clone(value.master?.document || blank()), presentation: clone(value.master?.presentation || { template: 'classic', paper: 'A4' }) });
  const version = value => value?.master?.version ?? 0;
  const accessError = error => ['LOCAL_LOCKED', 'LOCKED', 'STORAGE_LOCKED', 'IDENTITY_CHANGED', 'VAULT_LOCKED'].includes(error.code);
  async function request(op, input = {}) {
    const response = await window.companion.invoke(op, input);
    if (!response?.ok) throw Object.assign(new Error(response?.error?.message || 'Try again.'), { code: response?.error?.code });
    return response.result;
  }
  function node(tag, text, className) {
    const item = document.createElement(tag);
    if (text !== undefined) item.textContent = text;
    if (className) item.className = className;
    return item;
  }
  function button(text, action, label = text) {
    const item = node('button', text, 'text');
    item.type = 'button'; item.setAttribute('aria-label', label);
    item.addEventListener('click', action);
    return item;
  }
  function changed() { edits++; dirty = true; failure = ''; message = ''; renderState(); }
  function field(parent, target, key, label, path, { multiline = false, options = null, type = 'text' } = {}) {
    const wrapper = node('label', label, 'decisions-field');
    const input = node(options ? 'select' : multiline ? 'textarea' : 'input');
    if (options) for (const value of options) { const option = node('option', value); option.value = value; input.append(option); }
    else if (multiline) input.rows = 3;
    else input.type = type;
    input.value = target[key] ?? ''; input.dataset.field = path;
    input.addEventListener(options ? 'change' : 'input', () => { target[key] = input.value; changed(); });
    wrapper.append(input); parent.append(wrapper);
    return input;
  }
  function section(parent, title) {
    const group = node('section', undefined, 'master-cv-section');
    group.append(node('h3', title)); parent.append(group); return group;
  }
  function focusField(path) {
    [...el('fields').querySelectorAll('[data-field]')].find(input => input.dataset.field === path)?.focus();
  }
  function list(parent, target, key, title, make, draw, path) {
    const group = section(parent, title);
    const values = target[key] || [];
    values.forEach((value, index) => {
      const row = node('div', undefined, 'master-cv-entry');
      draw(row, value, index, `${path}.${index}`, values);
      const actions = node('div', undefined, 'actions master-cv-entry-actions');
      const move = delta => {
        [values[index], values[index + delta]] = [values[index + delta], values[index]];
        changed(); renderFields(); focusField(`${path}.${index + delta}.first`);
      };
      const up = button('Move up', () => move(-1), `Move ${title.toLowerCase()} entry ${index + 1} up`);
      const down = button('Move down', () => move(1), `Move ${title.toLowerCase()} entry ${index + 1} down`);
      up.disabled = index === 0; down.disabled = index === values.length - 1;
      actions.append(up, down, button('Remove', () => {
        values.splice(index, 1); changed(); renderFields();
        [...el('fields').querySelectorAll('[data-add]')].find(control => control.dataset.add === path)?.focus();
      }, `Remove ${title.toLowerCase()} entry ${index + 1}`));
      row.append(actions); group.append(row);
    });
    const add = button(`Add ${title.toLowerCase()}`, () => {
      target[key] ??= []; target[key].push(make()); changed(); renderFields();
      focusField(`${path}.${target[key].length - 1}.first`);
    });
    add.dataset.add = path; group.append(add);
    return group;
  }
  function strings(parent, target, key, title, path, multiline = false) {
    list(parent, target, key, title, () => '', (row, value, index, itemPath, values) => {
      field(row, values, index, `${title} ${index + 1}`, `${itemPath}.first`, { multiline });
    }, path);
  }
  function renderFields() {
    el('fields').replaceChildren();
    if (!draft) return;
    const container = el('fields'), doc = draft.document;
    const contact = section(container, 'Contact');
    const grid = node('div', undefined, 'master-cv-grid'); contact.append(grid);
    for (const [key, label, maxLength, type = 'text'] of contactFields) {
      const input = field(grid, draft.contact, key, label, `contact.${key}`, { type });
      input.maxLength = maxLength;
    }
    strings(contact, draft.contact, 'links', 'Link', 'contact.links');
    const bio = section(container, 'Headline and bio');
    field(bio, doc, 'headline', 'Headline', 'document.headline');
    field(bio, doc, 'summary', 'Bio', 'document.summary', { multiline: true });
    strings(container, doc, 'highlights', 'Highlight', 'document.highlights', true);
    list(container, doc, 'experience', 'Role', () => ({ employer: '', role: '', location: '', startDate: '', endDate: '', bullets: [] }), (row, role, index, path) => {
      const grid = node('div', undefined, 'master-cv-grid'); row.append(grid);
      for (const [key, label] of [['employer', 'Employer'], ['role', 'Role title'], ['location', 'Location'], ['startDate', 'Start date'], ['endDate', 'End date']])
        field(grid, role, key, label, key === 'employer' ? `${path}.first` : `${path}.${key}`);
      strings(row, role, 'bullets', 'Outcome or contribution', `${path}.bullets`, true);
    }, 'document.experience');
    if (doc.careerGaps?.length) {
      const gaps = section(container, 'Career breaks');
      gaps.append(node('p', 'These entries come from Career gap detection in CVs. Change their wording there.'));
      for (const gap of doc.careerGaps) gaps.append(node('p', [gap.activity, gap.place, [gap.startDate, gap.endDate].filter(Boolean).join(' – '), gap.description].filter(Boolean).join(' · ')));
      gaps.append(button('Edit gap settings', () => tabs.find(tab => tab.dataset.careerKind === 'sources').click()));
    }
    list(container, doc, 'skills', 'Skill group', () => ({ label: '', items: [] }), (row, value, index, path) => {
      field(row, value, 'label', 'Group name', `${path}.first`); strings(row, value, 'items', 'Skill', `${path}.items`);
    }, 'document.skills');
    list(container, doc, 'education', 'Education', () => ({ institution: '', qualification: '', startDate: '', endDate: '', details: '' }), (row, value, index, path) => {
      for (const [key, label] of [['institution', 'Institution'], ['qualification', 'Qualification'], ['startDate', 'Start date'], ['endDate', 'End date'], ['details', 'Details']])
        field(row, value, key, label, key === 'institution' ? `${path}.first` : `${path}.${key}`, { multiline: key === 'details' });
    }, 'document.education');
    list(container, doc, 'languages', 'Language', () => ({ language: '', proficiency: '' }), (row, value, index, path) => {
      field(row, value, 'language', 'Language', `${path}.first`); field(row, value, 'proficiency', 'Proficiency', `${path}.proficiency`);
    }, 'document.languages');
    strings(container, doc, 'certifications', 'Certification', 'document.certifications');
    list(container, doc, 'additional', 'Additional section', () => ({ title: '', items: [] }), (row, value, index, path) => {
      field(row, value, 'title', 'Section title', `${path}.first`); strings(row, value, 'items', 'Entry', `${path}.items`);
    }, 'document.additional');
    const presentation = section(container, 'Document format');
    field(presentation, draft.presentation, 'template', 'Template', 'presentation.template', { options: ['classic', 'modern'] });
    field(presentation, draft.presentation, 'paper', 'Paper', 'presentation.paper', { options: ['A4', 'LETTER'] });
  }
  function renderState() {
    const saved = incoming || baseline;
    const status = saved?.status;
    el('readiness').textContent = !online ? baseline ? 'Companion unavailable. Your edits are still here.' : 'Unlock or retry to see your master CV.'
      : !saved ? reading ? 'Loading master CV…' : 'Master CV unavailable. Choose Retry.'
        : ({ missing: 'No master CV yet.', draft: 'Draft · Not ready to export.', stale: 'Update needed · Your original CVs changed.', ready: 'Ready to export.' }[status] || 'Master CV status unavailable.');
    const onboarding = online && ['missing', 'draft', 'stale'].includes(status);
    el('review').textContent = onboarding ? 'Your connected AI app completes or updates the master CV as part of onboarding in your current or next conversation.' : '';
    el('status').textContent = pending === 'save' ? 'Saving…' : pending === 'export' ? 'Exporting…'
      : incoming ? 'Saved CV changed. Review the section choices before continuing to edit or save. Your unsaved changes are still here.'
        : [message, dirty ? 'Unsaved changes' : !message && baseline?.master ? 'Saved' : ''].filter(Boolean).join(' ');
    el('error').textContent = failure; el('error').hidden = !failure;
    el('retry').hidden = online && !failure;
    el('retry').disabled = reading || Boolean(pending);
    el('empty').hidden = !baseline || Boolean(draft);
    el('empty-note').textContent = hasCv ? 'Your original CVs are ready for your AI app. You can also write a draft here.' : 'Import an original CV using Import CV above. You can also write a draft here.';
    el('start').disabled = !online;
    el('form').hidden = !draft;
    el('fields').inert = Boolean(incoming);
    el('save').disabled = !online || reading || !draft || !dirty || Boolean(pending) || Boolean(incoming);
    el('save').textContent = pending === 'save' ? 'Saving…' : 'Save changes';
    el('discard').disabled = !dirty || Boolean(pending);
    for (const format of ['pdf', 'txt']) el(format).disabled = !online || dirty || Boolean(pending) || Boolean(incoming) || status !== 'ready' || !baseline?.master;
    el('export-note').textContent = dirty ? 'Save your changes before exporting.'
      : status === 'ready' ? 'Export the saved master CV. Tailoring a job application does not change it.'
        : status === 'draft' ? 'Complete the headline, bio and required role fields, then save before exporting.'
          : 'Your AI app prepares the master CV during onboarding before export is available.';
  }
  // Merge at named section boundaries: never silently replace a section changed on both sides.
  function mergePlan(remote) {
    const base = editable(baseline), next = editable(remote), merged = clone(draft), clashes = [];
    for (const group of ['contact', 'document', 'presentation']) {
      for (const key of new Set([...Object.keys(base[group]), ...Object.keys(next[group]), ...Object.keys(draft[group])])) {
        const localChanged = !equal(draft[group][key], base[group][key]);
        const remoteChanged = !equal(next[group][key], base[group][key]);
        if (localChanged && remoteChanged && !equal(draft[group][key], next[group][key])) clashes.push({ group, key });
        else if (!localChanged) {
          if (next[group][key] === undefined) delete merged[group][key]; else merged[group][key] = clone(next[group][key]);
        }
      }
    }
    return { merged, clashes };
  }
  function preview(value) {
    if (value === undefined || value === null || value === '') return 'Empty';
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) return value.map(preview).join('\n');
    return Object.values(value).map(preview).join(' · ');
  }
  function focusConflict() {
    if (!incoming || root.hidden || conflictFocused) return;
    el('conflict-title').focus();
    conflictFocused = true;
  }
  function renderConflict() {
    el('conflict').hidden = !incoming;
    el('conflict-fields').replaceChildren(); choices = new Map();
    if (!incoming) { conflictFocused = false; return; }
    conflicts = mergePlan(incoming).clashes;
    for (const { group, key } of conflicts) {
      const label = group === 'document' ? sectionNames[key] || key : contactFields.find(([field]) => field === key)?.[1] || key;
      const item = section(el('conflict-fields'), label);
      item.append(node('p', `Your version\n${preview(draft[group][key])}`, 'master-cv-comparison'), node('p', `Saved version\n${preview(editable(incoming)[group][key])}`, 'master-cv-comparison'));
      const selection = { value: '' };
      const input = field(item, selection, 'value', `Keep which ${label.toLowerCase()}?`, `conflict.${group}.${key}`, { options: ['', 'My edits', 'Saved version'] });
      input.addEventListener('change', () => { choices.set(`${group}.${key}`, input.value); el('merge').disabled = conflicts.some(part => !choices.get(`${part.group}.${part.key}`)); });
    }
    if (!conflicts.length) el('conflict-fields').append(node('p', 'The saved changes are in other sections. Apply them alongside your edits before saving.'));
    el('merge').disabled = conflicts.length > 0;
    focusConflict();
  }
  function accept(value) {
    if (value.identity !== identity) { clear(); return; }
    if (!baseline || !dirty) {
      const next = value.master ? editable(value) : null;
      const fieldsChanged = !equal(next, draft);
      baseline = value; incoming = null; dirty = false;
      if (fieldsChanged) { draft = next; renderFields(); }
      renderConflict();
    } else if (!equal(editable(value), editable(baseline)) || version(value) !== version(baseline)) {
      const changedIncoming = !incoming || !equal(editable(value), editable(incoming)) || version(value) !== version(incoming);
      incoming = value;
      if (changedIncoming) renderConflict();
    } else { baseline = value; }
    renderState();
  }
  async function load() {
    if (!online || reading || pending) return;
    const token = generation, loadingSignature = wantedSignature;
    reading = true; renderState();
    try {
      const result = await request('master-cv-read');
      if (token !== generation) return;
      signature = loadingSignature; failure = ''; accept(result);
    } catch (error) {
      if (token !== generation) return;
      if (accessError(error)) { clear(); return; }
      failure = `Could not read the master CV. ${error.message}`;
    } finally { if (token === generation) { reading = false; renderState(); } }
  }
  async function save(event) {
    event.preventDefault();
    if (el('save').disabled || !el('form').reportValidity()) return;
    const token = generation, submittedEdits = edits;
    const submitted = clone(draft);
    for (const [key] of contactFields) submitted.contact[key] = submitted.contact[key]?.trim() || null;
    submitted.contact.links = [...new Set((submitted.contact.links || []).map(link => link.trim()).filter(Boolean))];
    const input = { requestId: crypto.randomUUID(), revision: baseline.revision, baseVersion: version(baseline), ...submitted };
    pending = 'save'; failure = ''; renderState();
    try {
      const result = await request('master-cv-save', input);
      if (token !== generation) return;
      if (result.identity !== identity) { clear(); return; }
      baseline = result; incoming = null;
      if (submittedEdits === edits) { draft = editable(result); dirty = false; renderFields(); }
      message = dirty ? 'Saved. You have newer unsaved changes.' : 'Changes saved.';
      renderConflict();
    } catch (error) {
      if (token !== generation) return;
      if (accessError(error)) { clear(); return; }
      failure = `Could not save. Your edits are still here. ${error.message}`;
      if (/CONFLICT|STALE/.test(error.code || '')) {
        pending = ''; await load();
      }
    } finally {
      if (token === generation) { pending = ''; renderState(); if (wantedSignature !== signature && !reading) void load(); }
    }
  }
  async function perform(kind, operation, input, resultMessage) {
    if (!online || pending) return;
    const token = generation; pending = kind; failure = ''; renderState();
    try {
      const result = await request(operation, input);
      if (token !== generation) return;
      message = resultMessage(result);
    } catch (error) {
      if (token !== generation) return;
      if (accessError(error)) { clear(); return; }
      failure = `${error.message} Your edits are still here.`;
    } finally { if (token === generation) { pending = ''; renderState(); if (wantedSignature !== signature) void load(); } }
  }
  function clear() {
    generation++; baseline = null; draft = null; incoming = null; identity = null; signature = ''; wantedSignature = '';
    pending = ''; reading = false; online = false; dirty = false; failure = ''; message = ''; conflicts = []; choices.clear();
    conflictFocused = false;
    el('fields').replaceChildren(); el('conflict-fields').replaceChildren(); el('conflict').hidden = true;
    tabs.find(tab => tab.dataset.careerKind === 'master').disabled = true;
    renderState();
  }
  for (const tab of tabs) {
    tab.addEventListener('click', () => {
      if (tab.disabled) return;
      const master = tab.dataset.careerKind === 'master';
      root.hidden = !master; document.getElementById('me-saved-panes').hidden = master;
      document.getElementById('me-saved-panes').setAttribute('aria-labelledby', tab.id);
      for (const candidate of tabs) { candidate.setAttribute('aria-selected', String(candidate === tab)); candidate.tabIndex = candidate === tab ? 0 : -1; }
      if (master) focusConflict();
    });
    tab.addEventListener('keydown', event => {
      const available = tabs.filter(candidate => !candidate.disabled);
      let index = available.indexOf(tab);
      if (event.key === 'ArrowRight') index = (index + 1) % available.length;
      else if (event.key === 'ArrowLeft') index = (index + available.length - 1) % available.length;
      else if (event.key === 'Home') index = 0;
      else if (event.key === 'End') index = available.length - 1;
      else return;
      event.preventDefault(); available[index]?.focus(); available[index]?.click();
    });
  }
  el('form').addEventListener('submit', event => { void save(event); });
  el('retry').addEventListener('click', () => { online = true; void load(); });
  el('start').addEventListener('click', () => { draft = editable(baseline); changed(); renderFields(); focusField('contact.name'); });
  el('discard').addEventListener('click', () => {
    if (!window.confirm('Discard your unsaved master CV edits?')) return;
    const saved = incoming || baseline; dirty = false; accept(saved); message = 'Edits discarded.'; renderState();
  });
  el('merge').addEventListener('click', () => {
    if (!incoming || el('merge').disabled) return;
    const { merged } = mergePlan(incoming), remote = editable(incoming);
    for (const { group, key } of conflicts) if (choices.get(`${group}.${key}`) === 'Saved version') {
      if (remote[group][key] === undefined) delete merged[group][key]; else merged[group][key] = clone(remote[group][key]);
    }
    baseline = incoming; incoming = null; draft = merged; dirty = !equal(draft, editable(baseline)); edits++;
    failure = ''; message = dirty ? 'Choices applied. Save to keep your edits.' : 'Saved version kept.';
    renderFields(); renderConflict(); renderState();
  });
  for (const format of ['pdf', 'txt']) el(format).addEventListener('click', () => {
    if (el(format).disabled) return;
    void perform('export', 'master-cv-export', { requestId: crypto.randomUUID(), revision: baseline.revision, baseVersion: version(baseline), format }, result => result.exported ? `Exported ${result.filename || format.toUpperCase()}.` : 'Export canceled.');
  });
  window.addEventListener('beforeunload', event => { if (dirty) { event.preventDefault(); event.returnValue = ''; } });
  window.masterCvUI = {
    refresh(state) {
      if (state.execution?.state === 'locked') { clear(); return; }
      const nextIdentity = state.masterCv?.identity;
      if (identity && nextIdentity !== identity) clear();
      identity = nextIdentity; online = true; hasCv = Boolean(state.hasCv);
      tabs.find(tab => tab.dataset.careerKind === 'master').disabled = false;
      wantedSignature = JSON.stringify([state.masterCv, state.careerViewVersion]);
      if (wantedSignature !== signature) void load();
      renderState();
    },
    clear,
    unavailable() { generation++; reading = false; pending = ''; online = false; signature = ''; renderState(); },
  };
  clear();
})();
