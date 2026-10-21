// These functions are serialized by chrome.scripting; keep every dependency inside.
export function captureJobs() {
  const clean = (value, max = 60000) => String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
  const url = value => { try { const u = new URL(value, location.href); return /^https?:$/.test(u.protocol) && !u.username && !u.password && u.href.length <= 2000 ? u.href : null; } catch { return null; } };
  if (!url(location.href)) throw new Error('Open an HTTP or HTTPS job page with a URL under 2,000 characters.');
  const visible = el => !!el && !el.closest('[hidden],[aria-hidden="true"],nav,header,footer,form') && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden' && getComputedStyle(el).display !== 'none';
  const text = html => {
    // Template content is inert: no script execution or image/iframe downloads.
    const template = document.createElement('template');
    template.innerHTML = String(html).slice(0, 250000);
    template.content.querySelectorAll('script,style,form,input,textarea,select,button,noscript,iframe,object').forEach(el => el.remove());
    return clean(template.content.textContent);
  };
  const renderedText = root => {
    const parts = []; let count = 0, length = 0;
    const walk = node => {
      if (++count > 5000 || length > 60000) return;
      if (node.nodeType === 3) { parts.push(node.textContent.slice(0, 60001)); length += node.textContent.length; return; }
      if (node.nodeType !== 1 || /^(FORM|INPUT|TEXTAREA|SELECT|BUTTON|SCRIPT|STYLE|NAV|HEADER|FOOTER)$/.test(node.tagName) || !visible(node)) return;
      for (const child of node.childNodes) walk(child);
    };
    walk(root);
    const normalized = clean(parts.join(' '), Infinity);
    return { text: normalized.slice(0, 60000), complete: count <= 5000 && length <= 60000 && normalized.length <= 60000 };
  };
  const jobs = [], seen = new Map(); let bytes = 0;
  const sizeOf = row => new TextEncoder().encode(JSON.stringify(row)).length;
  const add = row => {
    if (!row.title || !row.url) return;
    const index = seen.get(row.url);
    if (index !== undefined) {
      const previous = jobs[index];
      const better = (row.complete && !previous.complete) || (row.complete === previous.complete && (row.description?.length ?? 0) > (previous.description?.length ?? 0));
      const merged = better ? { ...previous, ...row } : { ...row, ...previous };
      const nextBytes = bytes - sizeOf(previous) + sizeOf(merged);
      if (nextBytes <= 950000) { jobs[index] = merged; bytes = nextBytes; }
      return;
    }
    const size = sizeOf(row);
    if (jobs.length >= 50 || bytes + size > 950000) return;
    seen.set(row.url, jobs.length); jobs.push(row); bytes += size;
  };
  let visited = 0;
  const visit = (node, depth = 0) => {
    if (!node || typeof node !== 'object' || depth > 15 || ++visited > 3000 || jobs.length >= 50) return;
    if (Array.isArray(node)) { for (const item of node) visit(item, depth + 1); return; }
    if ([node['@type']].flat().some(type => /(?:^|\/)JobPosting$/.test(type))) {
      const jobUrl = url(node.url || node.mainEntityOfPage?.['@id'] || location.href);
      const description = node.description ? text(node.description) : '';
      const place = [node.jobLocation].flat().filter(Boolean).map(p => typeof p === 'string' ? p : [p.address?.addressLocality, p.address?.addressRegion, p.address?.addressCountry].filter(v => typeof v === 'string').join(', ')).filter(Boolean).join('; ');
      const row = { title: clean(node.title, 300), url: jobUrl, complete: !!description && typeof node.description === 'string' && node.description.length <= 60000 };
      if (description) row.description = description;
      if (node.hiringOrganization?.name) row.company = clean(node.hiringOrganization.name, 300);
      if (typeof node.datePosted === 'string' && /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2}))?$/.test(node.datePosted) && Number.isFinite(Date.parse(node.datePosted)) && new Date(node.datePosted.slice(0, 10)).toISOString().slice(0, 10) === node.datePosted.slice(0, 10)) row.publishedAt = node.datePosted;
      if (place) row.location = clean(place, 300);
      add(row);
    }
    for (const [key, value] of Object.entries(node).slice(0, 100)) if (key !== 'description') visit(value, depth + 1);
  };
  for (const script of [...document.querySelectorAll('script[type="application/ld+json"]')].slice(0, 32)) {
    if (script.textContent.length > 1000000) continue;
    try { visit(JSON.parse(script.textContent)); } catch { /* Invalid page metadata is not executable. */ }
  }
  const heading = document.querySelector('main h1,h1');
  const original = document.querySelector('[itemtype*="JobPosting"] [itemprop="description"],[data-job-description],#job-description,#jobDescription,.job-description,.jobDescription');
  if (visible(heading) && visible(original)) {
    const description = renderedText(original);
    if (description.text.length >= 200) {
      const row = { title: clean(heading.textContent, 300), url: url(location.href), description: description.text, complete: description.complete };
      const company = document.querySelector('[itemprop="hiringOrganization"],[data-company],[class*="company-name"]');
      if (visible(company)) row.company = clean(company.textContent, 300);
      add(row);
    }
  }
  const cards = [...document.querySelectorAll('[data-job-id],[data-jobid],[class*="job-card"],[class*="jobCard"],main article,main li')].slice(0, 500);
  for (const card of cards) {
    if (!visible(card)) continue;
    const links = [...card.querySelectorAll('a[href]')].filter(visible);
    const link = links.find(a => /(?:job|career|position|vacanc|opening)/i.test(a.getAttribute('href') || '') && clean(a.textContent).length > 2);
    if (!link) continue;
    const heading = card.querySelector('h2,h3,h4,[data-job-title],[class*="job-title"]');
    const title = clean(heading && visible(heading) ? renderedText(heading).text : renderedText(link).text, 300);
    if (!title || title.length < 3 || /^(apply|view|details|learn more|next|previous|sign in)$/i.test(title)) continue;
    const row = { title, url: url(link.href), description: renderedText(card).text.slice(0, 6000), complete: false };
    const company = card.querySelector('[data-company],[class*="company-name"],[class*="companyName"]');
    if (company && visible(company)) row.company = clean(company.textContent, 300);
    add(row);
  }
  return { url: location.href, title: clean(document.title, 500), jobs };
}

// Passing a snapshot with values invokes fill; without one this only inspects.
// The alias below has the same self-contained body when serialized by Chrome.
export function inspectForm(request = null) {
  const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, 500);
  let pageUrl;
  try { pageUrl = new URL(location.href); } catch { throw new Error('Open an HTTP or HTTPS application page.'); }
  if (!/^https?:$/.test(pageUrl.protocol) || pageUrl.username || pageUrl.password || pageUrl.href.length > 4096) throw new Error('Use an HTTP or HTTPS application URL without credentials, under 4,096 characters.');
  const hash = text => { let n = 2166136261; for (let i = 0; i < text.length; i++) n = Math.imul(n ^ text.charCodeAt(i), 16777619); return (n >>> 0).toString(16); };
  // Isolated-world memory binds the snapshot to actual control nodes, including
  // replacements that happen to have identical labels and attributes.
  const identityKey = Symbol.for('recruiters.form-controls.v1');
  const identities = globalThis[identityKey] ||= { document: crypto.randomUUID(), nodes: new WeakMap(), actionBindings: new WeakMap() };
  const identity = node => { if (!identities.nodes.has(node)) identities.nodes.set(node, crypto.randomUUID()); return identities.nodes.get(node); };
  const sensitive = /password|passcode|payment|credit.?card|debit.?card|card.?number|cardholder|\bcvv\b|\bcvc\b|\bcc-|transaction|bank|routing|iban|social.?security|\bssn\b|tax.?id|national.?(?:id|insurance)|passport|government|driver.?licen[cs]e|birth|\bbday\b|\bdob\b|\bage\b|\b(?:18|21)\s*(?:or older|years old|and over)|\bsex\b|gender|pronouns?|race|ethnic|nationality|citizenship|religio|disabil|medical|health|veteran|military|marital|sexual|demograph|self.?identif|signature|sign.?here|consent|agree|certif|attest|acknowledge|terms|privacy|background.?check|opt.?in|subscribe|marketing|permission|\bi confirm\b|\bi authorize\b|may we|can we contact|contact (?:my|your|me)\b|information.*(?:accurate|true)|(?:accurate|true).*information|i have read|expiry|expiration/i;
  const visible = el => !el.closest('[hidden],[aria-hidden="true"],inert') && el.getClientRects().length > 0 && getComputedStyle(el).display !== 'none' && getComputedStyle(el).visibility !== 'hidden';
  const labelFor = el => {
    const label = [...(el.labels || [])].map(l => { const copy = l.cloneNode(true); copy.querySelectorAll('input,select,textarea,button,script,style').forEach(n => n.remove()); return copy.textContent; }).join(' ');
    const labelled = (el.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean).map(id => document.getElementById(id)?.textContent || '').join(' ');
    const identifier = el.name || el.id || '';
    const parts = [...identifier.matchAll(/\[([^\]]+)\]/g)];
    const fallback = (parts.at(-1)?.[1] || identifier).replace(/[_-]+/g, ' ');
    return clean(el.getAttribute('aria-label') || labelled || label || el.getAttribute('placeholder') || fallback);
  };
  const protectedControl = el => sensitive.test([el.name, el.id, el.autocomplete, el.getAttribute('aria-label'), el.getAttribute('placeholder'), el.getAttribute('title'),
    ...(el.labels || [])].map(value => typeof value === 'string' ? value : value?.textContent || '').join(' ') + ' ' +
    ['aria-labelledby', 'aria-describedby'].map(key => (el.getAttribute(key) || '').split(/\s+/).filter(Boolean).map(id => document.getElementById(id)?.textContent || '').join(' ')).join(' ') + ' ' +
    (el.closest('fieldset')?.querySelector('legend')?.textContent || '')) || /(?:^|\s)(cc-|transaction-|bday|sex|one-time-code)/i.test(el.autocomplete || '');
  const disabled = el => el.disabled || el.matches(':disabled') || el.readOnly || el.closest('[aria-disabled="true"]');
  const formSignature = form => form ? [identity(form), ['action','method','enctype','target','novalidate'].map(key => form.getAttribute(key)), form.action, form.method, form.enctype, form.target, form.noValidate] : null;
  const controlSignature = el => JSON.stringify([identity(el), el.tagName, el.type, el.id, el.name, el.autocomplete, labelFor(el), protectedControl(el), clean(el.closest('fieldset')?.querySelector('legend')?.textContent), el.type === 'radio' ? el.value : null, !!disabled(el), el.required, el.getAttribute('aria-disabled'), ['min','max','step','pattern','minlength','maxlength','role','aria-autocomplete'].map(key => el.getAttribute(key)), formSignature(el.form), el.tagName === 'SELECT' ? [...el.options].slice(0, 101).map(o => [o.value, o.label, o.disabled, o.parentElement?.disabled]) : null]);
  const radioGroup = el => {
    const live = document.querySelectorAll('input[type="radio"]');
    if (live.length > 2000) return null;
    return [...live].filter(node => node.type === 'radio' && node.name === el.name && node.form === el.form);
  };
  const sameMembers = (live, group) => live && live.length === group.length && live.every((node, index) => node === group[index]);
  const controls = [...document.querySelectorAll('input,textarea,select')].slice(0, 2000);
  const schema = [], nodes = new Map(), radioSeen = new Set(); let schemaBytes = 0;
  for (let index = 0; index < controls.length && schema.length < 64; index++) {
    const el = controls[index], nativeType = el.tagName === 'TEXTAREA' ? 'textarea' : el.tagName === 'SELECT' ? 'select' : el.type;
    if (!['text','email','tel','url','textarea','select','radio','number','date'].includes(nativeType) || !visible(el)) continue;
    const label = labelFor(el);
    if (!label || protectedControl(el)) continue;
    let group = [el], options;
    if (nativeType === 'radio') {
      if (!el.name || radioSeen.has(el.name + ':' + [...document.forms].indexOf(el.form))) continue;
      radioSeen.add(el.name + ':' + [...document.forms].indexOf(el.form));
      group = radioGroup(el);
      if (!group || group.length > 100 || group.some(n => !visible(n) || n.value.length > 500 || protectedControl(n))) continue;
      options = group.map(n => ({ value: String(n.value).slice(0, 500), label: labelFor(n) }));
    } else if (nativeType === 'select') {
      if (el.multiple || el.options.length > 100) continue;
      options = [...el.options].filter(o => !o.disabled && !o.parentElement?.disabled && o.value.length <= 500).map(o => ({ value: String(o.value), label: clean(o.label) }));
    }
    if (options) options = options.filter(option => option.label && option.value !== '');
    if (options && (!options.length || new Set(options.map(option => option.value)).size !== options.length)) continue;
    const empty = nativeType === 'radio' ? group.every(n => !n.checked) : el.value === '';
    const customChoice = nativeType !== 'select' && (el.getAttribute('role') === 'combobox' || ['list', 'both'].includes(el.getAttribute('aria-autocomplete')));
    const field = { id: `control-${index}`, label: nativeType === 'radio' ? clean(el.closest('fieldset')?.querySelector('legend')?.textContent || label) : label, type: nativeType, signature: '', empty, required: group.some(n => n.required), manualOnly: !empty || customChoice || group.some(disabled) };
    if (el.autocomplete) field.autocomplete = clean(el.autocomplete);
    if (options) field.options = options;
    const fieldBytes = JSON.stringify(field).length * 3;
    if (schemaBytes + fieldBytes > 200000) continue;
    schemaBytes += fieldBytes;
    const signatures = group.map(controlSignature);
    schema.push(field); nodes.set(field.id, { el, group, signatures, check: () => group.every((node, i) => node.isConnected && visible(node) && controlSignature(node) === signatures[i]) && (nativeType !== 'radio' || sameMembers(radioGroup(el), group)) });
  }
  // Submit and next controls are inspected alongside the fields so the user's AI can name the exact
  // button later; pressing one is a separate, approved operation and never part of filling.
  const actions = [], actionNodes = new Map();
  const actionLabel = el => clean(el.tagName === 'INPUT' ? el.value : el.textContent) || clean(el.getAttribute('aria-label'));
  const actionSignature = el => JSON.stringify([identities.document, location.href, document.baseURI, identity(el), el.tagName, el.type, el.id, el.name, el.value, actionLabel(el), !!disabled(el), el.getAttribute('onclick'),
    ['form','formaction','formmethod','formenctype','formtarget','formnovalidate'].map(key => el.getAttribute(key)),
    el.formAction, el.formMethod, el.formEnctype, el.formTarget, el.formNoValidate,
    formSignature(el.form)]);
  const candidates = [...document.querySelectorAll('button,input[type="submit"],input[type="button"]')].slice(0, 500);
  for (let index = 0; index < candidates.length && actions.length < 10; index++) {
    const el = candidates[index];
    if (!(el.tagName === 'BUTTON' || el.tagName === 'INPUT') || !['submit', 'button'].includes(el.type) || !visible(el) || disabled(el)) continue;
    const label = actionLabel(el);
    if (!label || label.length > 120) continue;
    const kind = el.type === 'submit' || /\b(?:submit|apply|send)\b/i.test(label) ? 'submit' : /\b(?:next|continue|proceed)\b/i.test(label) ? 'next' : null;
    if (!kind) continue;
    const signature = actionSignature(el);
    let binding = identities.actionBindings.get(el);
    if (!binding || binding.signature !== signature) {
      binding = { el, signature, approvedSignature: crypto.randomUUID(), consumed: false, label, check: () => actionSignature(el), available: () => el.isConnected && visible(el) && !disabled(el) };
      identities.actionBindings.set(el, binding);
    }
    const action = { id: `action-${index}`, label, kind, signature: binding.approvedSignature };
    actions.push(action); actionNodes.set(action.id, binding);
  }
  // Bind each control to the complete current schema, URL and native constraints.
  const snapshot = hash(JSON.stringify([identities.document, location.href, schema, controls.map(controlSignature)]));
  for (const field of schema) { field.signature = `${snapshot}:${hash(JSON.stringify(field))}`; nodes.get(field.id).fieldSignature = field.signature; }
  // Keep the live bindings for smart paste and approved submit presses; values never live here.
  identities.url = location.href;
  identities.controls = nodes;
  identities.fields = new Map(schema.filter(field => !field.options).map(field => {
    const { el, signatures } = nodes.get(field.id);
    return [field.id, { el, signature: field.signature, check: () => identities.url === location.href && el.isConnected && visible(el) && !field.manualOnly && field.empty && !disabled(el) && el.value === '' && controlSignature(el) === signatures[0] }];
  }));
  identities.actions = actionNodes;
  if (!request) return { url: location.href, title: clean(document.title) || pageUrl.hostname, fields: schema, actions };
  if (request.url !== location.href || !Array.isArray(request.fields) || request.fields.length > 64) throw new Error('The page changed. Inspect the form again.');
  const current = new Map(schema.map(f => [f.id, f]));
  const selected = new Set();
  for (const field of request.fields) {
    const fresh = current.get(field.id);
    if (!fresh || fresh.signature !== field.signature || selected.has(field.id)) throw new Error('The form changed. Inspect it again before filling.');
    selected.add(field.id);
  }
  const filled = [], skipped = [];
  for (const field of request.fields) {
    const fresh = current.get(field.id), { el, group, signatures } = nodes.get(field.id), value = field.value;
    if (location.href !== request.url || group.some((node, i) => !visible(node) || controlSignature(node) !== signatures[i])) { skipped.push(field.id); continue; }
    if (fresh.manualOnly || !fresh.empty || typeof value !== 'string' || !value || value.length > 20000 || (fresh.options && !fresh.options.some(o => o.value === value))) { skipped.push(field.id); continue; }
    if (fresh.type === 'radio') {
      const live = radioGroup(el);
      if (!sameMembers(live, group) || live.some(node => node.checked)) { skipped.push(field.id); continue; }
    }
    const target = fresh.type === 'radio' ? group.find(n => n.value === value) : el;
    if (!target || !target.isConnected || disabled(target) || (fresh.type === 'radio' ? group.some(n => n.checked) : target.value !== '')) { skipped.push(field.id); continue; }
    if (fresh.type !== 'radio' && fresh.type !== 'select') {
      if (target.validity?.customError || (target.maxLength >= 0 && value.length > target.maxLength) || (target.minLength > 0 && value.length < target.minLength)) { skipped.push(field.id); continue; }
      const probe = target.cloneNode(false);
      probe.value = value;
      if (probe.value !== value || (probe.validity && !probe.validity.valid)) { skipped.push(field.id); continue; }
    }
    const prototype = fresh.type === 'textarea' ? HTMLTextAreaElement.prototype : fresh.type === 'select' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    const property = fresh.type === 'radio' ? 'checked' : 'value';
    const setter = Object.getOwnPropertyDescriptor(prototype, property)?.set;
    if (!setter) { skipped.push(field.id); continue; }
    setter.call(target, fresh.type === 'radio' ? true : value);
    target.dispatchEvent(new Event('input', { bubbles: true })); target.dispatchEvent(new Event('change', { bubbles: true }));
    const retained = target.isConnected && location.href === request.url && (fresh.type === 'radio' ? target.checked : target.value === value);
    if (retained) filled.push(field.id); else skipped.push(field.id);
  }
  // A later field handler may also reset an earlier field.
  const retained = filled.filter(id => {
    const fresh = current.get(id), { el, group } = nodes.get(id), value = request.fields.find(field => field.id === id).value;
    const target = fresh.type === 'radio' ? group.find(node => node.value === value) : el;
    const valid = target?.isConnected && location.href === request.url && (fresh.type === 'radio' ? sameMembers(radioGroup(el), group) && target.checked : target.value === value);
    if (!valid) skipped.push(id);
    return valid;
  });
  return { filled: retained, skipped };
}
export const fillForm = inspectForm;

export function checkFormBindings(request) {
  const identities = globalThis[Symbol.for('recruiters.form-controls.v1')];
  if (!identities || request?.url !== location.href || identities.url !== location.href || request.fields?.length !== identities.controls?.size || request.actions?.length !== identities.actions?.size) return { attached: false };
  const fieldsMatch = request.fields.every(field => {
    const bound = identities.controls.get(field.id);
    return bound?.fieldSignature === field.signature && bound.check();
  });
  const actionsMatch = request.actions.every(action => {
    const bound = identities.actions.get(action.id);
    return bound?.approvedSignature === action.signature && bound.available() && bound.check() === bound.signature;
  });
  return { attached: fieldsMatch && actionsMatch };
}

// Smart paste uses only the native clipboard API after a trusted click or Tab focus.
// It never intercepts paste or writes a synthetic paste/input event into the page.
export function armSmartPaste({ session } = {}) {
  const identities = globalThis[Symbol.for('recruiters.form-controls.v1')];
  if (!identities?.fields || typeof session !== 'string' || !session) throw new Error('Inspect and prepare the form before arming paste.');
  const armedKey = Symbol.for('recruiters.smart-paste.v1');
  const arm = globalThis[armedKey] ||= { active: false, listening: false, epoch: 0, selection: null };
  arm.active = true; arm.session = session; arm.epoch++; arm.selection = null;
  if (!arm.listening) {
    arm.listening = true;
    const invalidate = () => { arm.epoch++; arm.selection = null; };
    document.addEventListener('pointerdown', event => {
      invalidate();
      if (!arm.active || !event.isTrusted || event.button !== 0) return;
      const el = event.target?.closest?.('input,textarea') || event.target?.closest?.('label')?.control;
      if (el) arm.selection = { el, at: Date.now() };
    }, true);
    document.addEventListener('keydown', event => {
      if (event.key !== 'Tab') return;
      invalidate();
      if (arm.active && event.isTrusted && !event.altKey && !event.ctrlKey && !event.metaKey) arm.selection = { tab: true, at: Date.now() };
    }, true);
    document.addEventListener('focusout', () => { arm.epoch++; }, true);
    // Element blur precedes the next field's focusin. Do not capture it as a
    // window blur: that would erase the trusted click/Tab selection mid-switch.
    globalThis.addEventListener('blur', invalidate);
    document.addEventListener('visibilitychange', () => { if (document.visibilityState !== 'visible') invalidate(); }, true);
    document.addEventListener('focusin', event => {
      const selection = arm.selection;
      arm.selection = null;
      if (!arm.active || !event.isTrusted || !selection || Date.now() - selection.at > 1000) return;
      const bound = globalThis[Symbol.for('recruiters.form-controls.v1')], el = event.target;
      if (!selection.tab && selection.el !== el) return;
      for (const [fieldId, field] of bound?.fields ?? []) {
        if (field.el !== el) continue;
        const epoch = arm.epoch, session = arm.session;
        const current = () => arm.active && arm.session === session && arm.epoch === epoch && bound === globalThis[Symbol.for('recruiters.form-controls.v1')] && bound.fields.get(fieldId) === field &&
          document.activeElement === el && document.hasFocus() && field.check();
        if (!current() || !navigator.clipboard?.writeText) return;
        try {
          chrome.runtime.sendMessage({ action: 'paste-value', fieldId, signature: field.signature, url: location.href, session }, response => {
            if (chrome.runtime.lastError) return;
            const value = response?.value;
            if (typeof value !== 'string' || !value || value.length > 20000 || !current()) return;
            const report = ok => {
              if (!current()) return;
              try { chrome.runtime.sendMessage({ action: 'paste-ready', fieldId, signature: field.signature, url: location.href, session, ok }, () => void chrome.runtime.lastError); } catch { /* The extension disconnected. */ }
            };
            try { navigator.clipboard.writeText(value).then(() => report(true), () => report(false)); } catch { report(false); }
          });
        } catch { /* The extension disconnected; nothing reaches the clipboard. */ }
        return;
      }
    }, true);
  }
  return { armed: true, fields: [...identities.fields.values()].filter(field => field.check()).length };
}
export function disarmSmartPaste() {
  const arm = globalThis[Symbol.for('recruiters.smart-paste.v1')];
  if (arm) { arm.active = false; arm.session = null; arm.epoch++; arm.selection = null; }
  return { armed: false };
}

// Consume the exact inspected action before clicking: an uncertain result must not be retried.
export function pressAction(request) {
  const identities = globalThis[Symbol.for('recruiters.form-controls.v1')];
  const bound = identities?.actions?.get(request?.actionId);
  if (!bound || identities.url !== location.href || request.url !== location.href) throw new Error('The page changed. Inspect the form again before submitting.');
  if (request.actionSignature !== bound.approvedSignature || !bound.available() || bound.check() !== bound.signature) throw new Error('The submit control changed. Inspect the form again before submitting.');
  if (bound.consumed) throw new Error('This approved control has already been pressed. Check the page; it will not be pressed again.');
  bound.consumed = true;
  bound.el.click();
  return { clicked: true, label: bound.label, url: location.href };
}

// Page text is evidence to review, not proof that the site accepted an application.
export function observePage() {
  const identities = globalThis[Symbol.for('recruiters.form-controls.v1')];
  const fields = identities?.fields ? [...identities.fields.values()] : [];
  const clean = value => String(value ?? '').replace(/\s+/g, ' ').trim();
  const visible = el => el.isConnected && !el.closest('[hidden],[aria-hidden="true"],inert') && el.getClientRects().length > 0 && getComputedStyle(el).display !== 'none' && getComputedStyle(el).visibility !== 'hidden';
  const visibleFields = fields.filter(field => visible(field.el)).length;
  const observedText = clean(document.body?.innerText).slice(0, 30000);
  const confirmationCandidates = [...observedText.matchAll(/[^.!?]{0,80}(?:thank you|thanks for applying|application (?:has been |was |is )?(?:received|submitted|sent|complete)|we(?:'ve| have) received|successfully (?:submitted|applied))[^.!?]{0,80}/gi)]
    .slice(0, 5).map(match => match[0].trim().slice(0, 240));
  const alerts = [...document.querySelectorAll('[role="alert"],[aria-invalid="true"],.error,.field-error')].slice(0, 20).filter(visible)
    .map(el => clean(el.getAttribute('aria-label') || el.textContent || el.validationMessage)).filter(Boolean).slice(0, 5).map(item => item.slice(0, 200));
  return { url: location.href, title: clean(document.title).slice(0, 300), fieldsInspected: fields.length, fieldsVisible: visibleFields,
    observedText, confirmationCandidates, outcome: 'unknown', alerts };
}
