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
  const identities = globalThis[identityKey] ||= { document: crypto.randomUUID(), nodes: new WeakMap() };
  const identity = node => { if (!identities.nodes.has(node)) identities.nodes.set(node, crypto.randomUUID()); return identities.nodes.get(node); };
  const sensitive = /password|passcode|payment|credit.?card|debit.?card|card.?number|cardholder|\bcvv\b|\bcvc\b|\bcc-|transaction|bank|routing|iban|social.?security|\bssn\b|tax.?id|national.?(?:id|insurance)|passport|government|driver.?licen[cs]e|birth|\bbday\b|\bdob\b|\bage\b|\b(?:18|21)\s*(?:or older|years old|and over)|\bsex\b|gender|pronouns?|race|ethnic|nationality|citizenship|religio|disabil|medical|health|veteran|military|marital|sexual|demograph|self.?identif|signature|sign.?here|consent|agree|certif|attest|acknowledge|terms|privacy|background.?check|opt.?in|subscribe|marketing|permission|\bi confirm\b|\bi authorize\b|may we|can we contact|contact (?:my|your|me)\b|information.*(?:accurate|true)|(?:accurate|true).*information|i have read|expiry|expiration/i;
  const visible = el => !el.closest('[hidden],[aria-hidden="true"],inert') && el.getClientRects().length > 0 && getComputedStyle(el).display !== 'none' && getComputedStyle(el).visibility !== 'hidden';
  const labelFor = el => {
    const label = [...(el.labels || [])].map(l => { const copy = l.cloneNode(true); copy.querySelectorAll('input,select,textarea,button,script,style').forEach(n => n.remove()); return copy.textContent; }).join(' ');
    const labelled = (el.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean).map(id => document.getElementById(id)?.textContent || '').join(' ');
    return clean(el.getAttribute('aria-label') || labelled || label || el.getAttribute('placeholder') || el.name || el.id);
  };
  const controlSignature = el => JSON.stringify([identity(el), el.tagName, el.type, el.id, el.name, el.autocomplete, labelFor(el), clean(el.closest('fieldset')?.querySelector('legend')?.textContent), el.type === 'radio' ? el.value : null, el.disabled, el.readOnly, el.required, el.getAttribute('aria-disabled'), ['min','max','step','pattern','maxlength'].map(key => el.getAttribute(key)), el.form ? [identity(el.form), el.form.action, el.form.method, el.form.enctype] : null, el.tagName === 'SELECT' ? [...el.options].slice(0, 101).map(o => [o.value, o.label, o.disabled, o.parentElement?.disabled]) : null]);
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
    const label = labelFor(el), context = [label, el.name, el.id, el.autocomplete, el.closest('fieldset')?.querySelector('legend')?.textContent].join(' ');
    if (!label || sensitive.test(context) || /(?:^|\s)(cc-|transaction-|bday|sex|one-time-code)/i.test(el.autocomplete || '')) continue;
    let group = [el], options;
    if (nativeType === 'radio') {
      if (!el.name || radioSeen.has(el.name + ':' + [...document.forms].indexOf(el.form))) continue;
      radioSeen.add(el.name + ':' + [...document.forms].indexOf(el.form));
      group = radioGroup(el);
      if (!group || group.length > 100 || group.some(n => !visible(n) || n.value.length > 500 || sensitive.test(labelFor(n)))) continue;
      options = group.map(n => ({ value: String(n.value).slice(0, 500), label: labelFor(n) }));
    } else if (nativeType === 'select') {
      if (el.multiple || el.options.length > 100) continue;
      options = [...el.options].filter(o => !o.disabled && !o.parentElement?.disabled && o.value.length <= 500).map(o => ({ value: String(o.value), label: clean(o.label) }));
    }
    if (options) options = options.filter(option => option.label && option.value !== '');
    if (options && (!options.length || new Set(options.map(option => option.value)).size !== options.length)) continue;
    const empty = nativeType === 'radio' ? group.every(n => !n.checked) : el.value === '';
    const field = { id: `control-${index}`, label: nativeType === 'radio' ? clean(el.closest('fieldset')?.querySelector('legend')?.textContent || label) : label, type: nativeType, signature: '', empty, required: group.some(n => n.required), manualOnly: !empty || group.some(n => n.disabled || n.readOnly || n.getAttribute('aria-disabled') === 'true') };
    if (el.autocomplete) field.autocomplete = clean(el.autocomplete);
    if (options) field.options = options;
    const fieldBytes = JSON.stringify(field).length * 3;
    if (schemaBytes + fieldBytes > 200000) continue;
    schemaBytes += fieldBytes;
    schema.push(field); nodes.set(field.id, { el, group, signatures: group.map(controlSignature) });
  }
  // Bind each control to the complete current schema, URL and native constraints.
  const snapshot = hash(JSON.stringify([identities.document, location.href, schema, controls.map(controlSignature)]));
  for (const field of schema) field.signature = `${snapshot}:${hash(JSON.stringify(field))}`;
  if (!request) return { url: location.href, title: clean(document.title) || pageUrl.hostname, fields: schema };
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
    if (!target || !target.isConnected || target.disabled || target.readOnly || (fresh.type === 'radio' ? group.some(n => n.checked) : target.value !== '')) { skipped.push(field.id); continue; }
    if (fresh.type !== 'radio' && fresh.type !== 'select' && target.maxLength >= 0 && value.length > target.maxLength) { skipped.push(field.id); continue; }
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
