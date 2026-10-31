// These functions are serialized by scripting.executeScript; keep dependencies inside.
export function captureJobs(_request, expectedDocument) {
  if (expectedDocument && globalThis[Symbol.for('recruiters.form-controls.v1')]?.document !== expectedDocument) throw new Error('The inspected document changed.');
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

// Inspect controls without writing values or activating page actions.
export function inspectForm(_request, expectedDocument) {
  if (expectedDocument && globalThis[Symbol.for('recruiters.form-controls.v1')]?.document !== expectedDocument) throw new Error('The inspected document changed.');
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
  // Placeholder prompts ("Start typing…", "Select…") are not questions; prefer the visible question text before the control.
  const placeholderLike = text => /^(?:start typing|type here|type to search|type your answer|search|select|choose|pick one|please select|please choose|enter (?:a |an |your )?(?:answer|value|text))\b[^?]{0,30}$/i.test(text);
  const textOf = node => { const copy = node.cloneNode(true); copy.querySelectorAll?.('input,select,textarea,button,script,style').forEach(n => n.remove()); return clean(copy.textContent); };
  const precedingQuestion = el => {
    for (let node = el, depth = 0; node && depth < 4; node = node.parentElement, depth++) {
      for (let sibling = node.previousElementSibling, count = 0; sibling && count < 3; sibling = sibling.previousElementSibling, count++) {
        // Another control before this one belongs to a different question.
        if (/^(?:INPUT|SELECT|TEXTAREA)$/.test(sibling.tagName) || sibling.querySelector?.('input,select,textarea')) return '';
        const text = textOf(sibling);
        if (text && !placeholderLike(text)) return text;
      }
    }
    return '';
  };
  const labelFor = el => {
    const label = [...(el.labels || [])].map(textOf).join(' ');
    const labelled = (el.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean).map(id => document.getElementById(id)?.textContent || '').join(' ');
    const identifier = el.name || el.id || '';
    const parts = [...identifier.matchAll(/\[([^\]]+)\]/g)];
    const fallback = (parts.at(-1)?.[1] || identifier).replace(/[_-]+/g, ' ');
    const named = [el.getAttribute('aria-label'), labelled, label, el.getAttribute('placeholder')].map(clean).filter(Boolean);
    return named.find(text => !placeholderLike(text)) || precedingQuestion(el) || named[0] || clean(fallback);
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
  // Mutually exclusive buttons (Ashby's Yes/No uses aria-pressed) and ARIA radios are one choice field the user clicks.
  const choiceButton = el => el.tagName !== 'INPUT' && (el.getAttribute('role') === 'radio' || (el.tagName === 'BUTTON' && el.getAttribute('aria-pressed') !== null));
  const choiceGroup = el => [...(el.parentElement?.children ?? [])].filter(choiceButton);
  const groupLabel = box => clean(box.getAttribute('aria-label') || (box.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean).map(id => document.getElementById(id)?.textContent || '').join(' ') ||
    box.closest('fieldset')?.querySelector('legend')?.textContent || precedingQuestion(box));
  const controls = [...document.querySelectorAll('input,textarea,select,button[aria-pressed],[role="radio"]')].slice(0, 2000);
  const schema = [], nodes = new Map(), radioSeen = new Set(), choiceSeen = new Set(); let schemaBytes = 0;
  for (let index = 0; index < controls.length && schema.length < 64; index++) {
    const el = controls[index], choice = choiceButton(el), nativeType = choice ? 'radio' : el.tagName === 'TEXTAREA' ? 'textarea' : el.tagName === 'SELECT' ? 'select' : el.type;
    if (!['text','email','tel','url','textarea','select','radio','number','date'].includes(nativeType) || !visible(el) || choiceSeen.has(el)) continue;
    const label = choice ? el.parentElement && groupLabel(el.parentElement) : labelFor(el);
    if (!label || protectedControl(el) || (choice && sensitive.test(label))) continue;
    let group = [el], options;
    if (choice) {
      group = choiceGroup(el);
      group.forEach(node => choiceSeen.add(node));
      if (group.length < 2 || group.length > 20 || group.some(n => !visible(n) || protectedControl(n))) continue;
      options = group.map(n => { const text = clean(n.textContent) || clean(n.getAttribute('aria-label')); return { value: text, label: text }; });
    } else if (nativeType === 'radio') {
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
    const empty = choice ? group.every(n => n.getAttribute('aria-pressed') !== 'true' && n.getAttribute('aria-checked') !== 'true') : nativeType === 'radio' ? group.every(n => !n.checked) : el.value === '';
    const customChoice = nativeType !== 'select' && (el.getAttribute('role') === 'combobox' || ['list', 'both'].includes(el.getAttribute('aria-autocomplete')));
    const field = { id: `control-${index}`, label: nativeType === 'radio' && !choice ? clean(el.closest('fieldset')?.querySelector('legend')?.textContent || label) : label, type: nativeType, signature: '', empty, required: group.some(n => n.required), manualOnly: !empty || customChoice || group.some(disabled) };
    if (el.autocomplete) field.autocomplete = clean(el.autocomplete);
    if (el.getAttribute('maxlength') !== null && Number.isInteger(el.maxLength) && el.maxLength >= 0)
      field.maxLength = Math.min(el.maxLength, 10000);
    if (options) field.options = options;
    const fieldBytes = JSON.stringify(field).length * 3;
    if (schemaBytes + fieldBytes > 200000) continue;
    schemaBytes += fieldBytes;
    const signatures = group.map(controlSignature);
    schema.push(field); nodes.set(field.id, { el, group, signatures, check: () => group.every((node, i) => node.isConnected && visible(node) && controlSignature(node) === signatures[i]) && (nativeType !== 'radio' || sameMembers(choice ? choiceGroup(el) : radioGroup(el), group)) });
  }
  // Submit and next controls are read-only context for the host's computer-use tools.
  const actions = [], actionNodes = new Map();
  const actionLabel = el => clean(el.tagName === 'INPUT' ? el.value : el.textContent) || clean(el.getAttribute('aria-label'));
  const actionSignature = el => JSON.stringify([identities.document, location.href, document.baseURI, identity(el), el.tagName, el.type, el.id, el.name, el.value, actionLabel(el), !!disabled(el), el.getAttribute('onclick'),
    ['form','formaction','formmethod','formenctype','formtarget','formnovalidate'].map(key => el.getAttribute(key)),
    el.formAction, el.formMethod, el.formEnctype, el.formTarget, el.formNoValidate,
    formSignature(el.form)]);
  const candidates = [...document.querySelectorAll('button,input[type="submit"],input[type="button"]')].slice(0, 500);
  for (let index = 0; index < candidates.length && actions.length < 10; index++) {
    const el = candidates[index];
    if (!(el.tagName === 'BUTTON' || el.tagName === 'INPUT') || !['submit', 'button'].includes(el.type) || choiceButton(el) || !visible(el) || disabled(el)) continue;
    const label = actionLabel(el);
    if (!label || label.length > 120) continue;
    const kind = el.type === 'submit' || /\b(?:submit|apply|send)\b/i.test(label) ? 'submit' : /\b(?:next|continue|proceed)\b/i.test(label) ? 'next' : null;
    if (!kind) continue;
    const signature = actionSignature(el);
    let binding = identities.actionBindings.get(el);
    if (!binding || binding.signature !== signature) {
      binding = { signature, snapshotSignature: crypto.randomUUID(), check: () => actionSignature(el), available: () => el.isConnected && visible(el) && !disabled(el) };
      identities.actionBindings.set(el, binding);
    }
    const action = { id: `action-${index}`, label, kind, signature: binding.snapshotSignature };
    actions.push(action); actionNodes.set(action.id, binding);
  }
  // Bind each control to the complete current schema, URL and native constraints.
  const snapshot = hash(JSON.stringify([identities.document, location.href, schema, controls.map(controlSignature)]));
  for (const field of schema) { field.signature = `${snapshot}:${hash(JSON.stringify(field))}`; nodes.get(field.id).fieldSignature = field.signature; }
  // Keep live bindings for attachment checks and smart paste; values never live here.
  identities.url = location.href;
  identities.controls = nodes;
  identities.fields = new Map(schema.filter(field => !field.options).map(field => {
    const { el, signatures } = nodes.get(field.id);
    return [field.id, { el, signature: field.signature, check: () => identities.url === location.href && el.isConnected && visible(el) && !field.manualOnly && field.empty && !disabled(el) && el.value === '' && controlSignature(el) === signatures[0] }];
  }));
  identities.actions = actionNodes;
  return { url: location.href, title: clean(document.title) || pageUrl.hostname, fields: schema, actions, documentToken: identities.document };
}

export function checkFormBindings(request, expectedDocument) {
  if (expectedDocument && globalThis[Symbol.for('recruiters.form-controls.v1')]?.document !== expectedDocument) throw new Error('The inspected document changed.');
  const identities = globalThis[Symbol.for('recruiters.form-controls.v1')];
  if (!identities || request?.url !== location.href || identities.url !== location.href || request.fields?.length !== identities.controls?.size || request.actions?.length !== identities.actions?.size) return { attached: false };
  const fieldsMatch = request.fields.every(field => {
    const bound = identities.controls.get(field.id);
    return bound?.fieldSignature === field.signature && bound.check();
  });
  const actionsMatch = request.actions.every(action => {
    const bound = identities.actions.get(action.id);
    return bound?.snapshotSignature === action.signature && bound.available() && bound.check() === bound.signature;
  });
  return { attached: fieldsMatch && actionsMatch };
}

// Smart paste uses only the native clipboard API after a trusted click or Tab focus.
// It never intercepts paste or writes a synthetic paste/input event into the page.
export function armSmartPaste({ session, capture = [] } = {}, expectedDocument) {
  if (expectedDocument && globalThis[Symbol.for('recruiters.form-controls.v1')]?.document !== expectedDocument) throw new Error('The inspected document changed.');
  const identities = globalThis[Symbol.for('recruiters.form-controls.v1')];
  if (!identities?.fields || typeof session !== 'string' || !session) throw new Error('Inspect and prepare the form before arming paste.');
  const armedKey = Symbol.for('recruiters.smart-paste.v1');
  const arm = globalThis[armedKey] ||= { active: false, listening: false, epoch: 0, selection: null };
  arm.active = true; arm.session = session; arm.epoch++; arm.selection = null;
  arm.capture = new Map((Array.isArray(capture) ? capture : []).map(item => [item.id, item.signature]));
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
    // Firefox's browser namespace is Promise-only; Chrome's callback keeps
    // runtime.lastError scoped to the callback that owns it.
    const send = message => globalThis.browser?.runtime
      ? globalThis.browser.runtime.sendMessage(message)
      : new Promise((resolve, reject) => {
        globalThis.chrome.runtime.sendMessage(message, response => {
          const error = globalThis.chrome.runtime.lastError;
          if (error) reject(new Error(error.message)); else resolve(response);
        });
      });
    // A committed value (change fires on blur or selection, never per keystroke) in a field
    // that was missing when prepared. Companion decides whether it is worth keeping.
    document.addEventListener('change', event => {
      if (!arm.active || !event.isTrusted) return;
      const bound = globalThis[Symbol.for('recruiters.form-controls.v1')];
      for (const [fieldId, signature] of arm.capture ?? []) {
        const control = bound?.controls?.get(fieldId);
        if (!control?.group.includes(event.target)) continue;
        if (control.fieldSignature !== signature || !control.check()) return;
        const value = control.el.type === 'radio' ? control.group.find(node => node.checked)?.value ?? '' : control.el.tagName === 'SELECT' ? control.el.value : String(control.el.value ?? '').trim();
        if (!value || value.length > 10000) return;
        try {
          void send({ action: 'answer-captured', fieldId, signature, value, url: location.href, session: arm.session, documentToken: bound.document }).catch(() => {});
        } catch { /* The extension disconnected. */ }
        return;
      }
    }, true);
    const select = (event, el = event.target) => {
      const selection = arm.selection;
      arm.selection = null;
      if (!arm.active || !event.isTrusted || !selection || Date.now() - selection.at > 1000) return;
      const bound = globalThis[Symbol.for('recruiters.form-controls.v1')];
      if (!selection.tab && selection.el !== el) return;
      for (const [fieldId, field] of bound?.fields ?? []) {
        if (field.el !== el) continue;
        const epoch = arm.epoch, session = arm.session;
        const current = () => arm.active && arm.session === session && arm.epoch === epoch && bound === globalThis[Symbol.for('recruiters.form-controls.v1')] && bound.fields.get(fieldId) === field &&
          document.activeElement === el && document.hasFocus() && field.check();
        if (!current() || !navigator.clipboard?.writeText) return;
        const message = { fieldId, signature: field.signature, url: location.href, session, documentToken: bound.document };
        try {
          void send({ ...message, action: 'paste-value' }).then(async response => {
            const value = response?.value;
            if (typeof value !== 'string' || !value || value.length > 20000 || !current()) return;
            let ok = false;
            try { await navigator.clipboard.writeText(value); ok = true; } catch { /* Report the actual clipboard outcome. */ }
            if (current()) await send({ ...message, action: 'paste-ready', ok });
          }).catch(() => { /* The extension disconnected; never synthesize a paste. */ });
        } catch { /* The extension disconnected before sending. */ }
        return;
      }
    };
    document.addEventListener('focusin', select, true);
    // An already focused control emits click, but no new focusin, including
    // when the user returns from the panel after answers have been refreshed.
    document.addEventListener('click', event => {
      if (event.button !== 0) return;
      const el = event.target?.closest?.('input,textarea') || event.target?.closest?.('label')?.control;
      if (el && document.activeElement === el) select(event, el);
    }, true);
    document.addEventListener('input', event => {
      if (!arm.active || !event.isTrusted || document.activeElement !== event.target) return;
      invalidate();
      if (event.target.value !== '') return;
      arm.selection = { el: event.target, at: Date.now() };
      select(event);
    }, true);
  }
  return { armed: true, fields: [...identities.fields.values()].filter(field => field.check()).length };
}
export function disarmSmartPaste(_request, expectedDocument) {
  if (expectedDocument && globalThis[Symbol.for('recruiters.form-controls.v1')]?.document !== expectedDocument) throw new Error('The inspected document changed.');
  const arm = globalThis[Symbol.for('recruiters.smart-paste.v1')];
  if (arm) { arm.active = false; arm.session = null; arm.epoch++; arm.selection = null; }
  return { armed: false };
}

// Capture only public job context. Entered form values are deliberately excluded.
// Linked descriptions are fetched only from this page's origin; the agent must
// retrieve the supplied job link itself when no complete original is available.
export async function captureApplicationContext(_request, expectedDocument) {
  if (expectedDocument && globalThis[Symbol.for('recruiters.form-controls.v1')]?.document !== expectedDocument) throw new Error('The inspected document changed.');
  const here = new URL(location.href);
  if (!['http:', 'https:'].includes(here.protocol) || here.username || here.password) return { jobLinks: [] };
  const clean = value => String(value ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim();
  const urlFor = value => {
    try {
      const url = new URL(value, here);
      if (url.origin !== here.origin || url.username || url.password || url.href.length > 2000) return null;
      url.hash = ''; return url;
    } catch { return null; }
  };
  const token = url => url.pathname.match(/\/(?:postings|jobs|positions|roles)\/([^/]+)/i)?.[1]
    || url.pathname.match(/\/([a-f0-9]{8}-[a-f0-9-]{27,})(?:\/|$)/i)?.[1]
    || url.searchParams.get('gh_jid');
  const jobToken = token(here), links = new Map();
  for (const anchor of [...document.querySelectorAll('a[href]')].slice(0, 1000)) {
    const url = urlFor(anchor.getAttribute('href')), title = clean(anchor.textContent).replace(/\s+/g, ' ').slice(0, 300);
    if (!url || url.href === here.href || /\/(?:applications?|apply)(?:\/|$)/i.test(url.pathname) || !title) continue;
    const sameJob = jobToken && token(url) === jobToken;
    const descriptionLink = /\b(?:job description|view (?:the )?job|back to (?:the )?(?:job|role)|position details)\b/i.test(title);
    if ((sameJob || descriptionLink) && links.size < 6) links.set(url.href, { url: url.href, title });
  }
  const jobLinks = [...links.values()];
  const textFromHtml = html => {
    const template = document.createElement('template');
    template.innerHTML = html;
    template.content.querySelectorAll('script,style,noscript,form,input,textarea,select,button,iframe,object,nav,header,footer').forEach(node => node.remove());
    for (const node of template.content.querySelectorAll('p,div,li,h1,h2,h3,br')) node.prepend(document.createTextNode('\n'));
    return clean(template.content.textContent).replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n');
  };
  const originalFrom = (doc, url) => {
    const postings = [];
    let visited = 0;
    const walk = (value, depth = 0) => {
      if (!value || typeof value !== 'object' || depth > 12 || ++visited > 2000) return;
      if (Array.isArray(value)) { for (const item of value) walk(item, depth + 1); return; }
      if ([value['@type']].flat().some(type => /(?:^|\/)JobPosting$/.test(type || '')) && typeof value.description === 'string') postings.push(value);
      for (const [key, item] of Object.entries(value).slice(0, 100)) if (key !== 'description') walk(item, depth + 1);
    };
    for (const script of [...doc.querySelectorAll('script[type="application/ld+json"]')].slice(0, 20)) {
      if (script.textContent.length > 500000) continue;
      try { walk(JSON.parse(script.textContent)); } catch { /* Structured page data is inert. */ }
    }
    if (postings.length === 1) {
      const job = postings[0], body = textFromHtml(job.description);
      const title = clean(typeof job.title === 'string' ? job.title : typeof job.name === 'string' ? job.name : doc.querySelector('h1')?.textContent).slice(0, 300);
      let originalUrl = url;
      try {
        const declared = new URL(job.url || job.mainEntityOfPage?.['@id'] || url, url);
        if (!['http:', 'https:'].includes(declared.protocol) || declared.username || declared.password || declared.href.length > 2000) return null;
        // A foreign canonical claim cannot establish where this advert was read.
        if (declared.origin === new URL(url).origin) originalUrl = declared.href;
      } catch { return null; }
      if (title && body && body.length <= 100000) return { url: originalUrl, title, text: body, complete: true };
    }
    if (postings.length > 1) return null;
    const description = doc.querySelector('[itemtype*="JobPosting"] [itemprop="description"],[data-job-description],#job-description,#jobDescription,.job-description,.jobDescription');
    const main = description || doc.querySelector('main,article,[role="main"]');
    if (!main) return null;
    const text = textFromHtml(main.innerHTML);
    if (!text || text.length > 100000) return null;
    // A main/article element is a reading surface, not evidence of a vacancy.
    // Generic adverts need both substantive hiring sections and an apply action.
    const sections = [
      /\b(?:responsibilities|what you(?: will|'ll) do|about (?:the|this) role)\b/i,
      /\b(?:qualifications|requirements|what you(?: will|'ll) bring|what we(?: are|'re) looking for)\b/i,
      /\b(?:benefits|compensation|salary|employment type|full[ -]time|part[ -]time)\b/i,
    ].filter(pattern => pattern.test(text)).length;
    const apply = [...doc.querySelectorAll('a[href],button,input[type="submit"]')].slice(0, 1000)
      .some(node => /^(?:apply(?: now| here| for (?:this|the) (?:job|role|position))?|submit application)$/i.test(clean(node.textContent || node.getAttribute('value'))));
    if (!description && !(sections >= 2 && apply)) return null;
    // Unstructured HTML can omit client-rendered sections. Keep it useful to the
    // host, but never claim completeness from headings or text length alone.
    return { url, title: clean(doc.querySelector('h1')?.textContent || doc.title).slice(0, 300), text, complete: false };
  };
  const current = originalFrom(document, here.href);
  if (current?.complete) return { original: current, jobLinks };
  if (jobLinks.length !== 1) return { ...(current ? { original: current } : {}), jobLinks };
  const abort = new AbortController(), timer = setTimeout(() => abort.abort(), 8000);
  try {
    const response = await fetch(jobLinks[0].url, { credentials: 'same-origin', redirect: 'error', signal: abort.signal });
    if (!response.ok || !response.headers.get('content-type')?.includes('text/html') || Number(response.headers.get('content-length') || 0) > 1000000 || !response.body) return { jobLinks };
    const reader = response.body.getReader(), chunks = []; let total = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > 1000000) { await reader.cancel(); return { jobLinks }; }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    const bytes = new Uint8Array(total); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const template = document.createElement('template');
    template.innerHTML = new TextDecoder().decode(bytes);
    const doc = template.content;
    const original = originalFrom(doc, jobLinks[0].url);
    return { ...(original ? { original } : {}), jobLinks };
  } catch { return { jobLinks }; }
  finally { clearTimeout(timer); }
}
