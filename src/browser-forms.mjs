import { CareerError, fail, hash, readCareer } from './mcp/state.mjs';
import { formEvidence, formFingerprint, unavailableField, validFormValue, validateFormSnapshot } from './mcp/form-tools.mjs';
import { abortable, FORM_DECISIONS, mapFormValues } from './decisions/form-mapping.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PRICE_NOTE = 'Separate OpenAI API billing, not your ChatGPT subscription. Base rate per million input tokens; regional or long-context premiums may apply. Already dispatched requests may be billed after cancellation.';
const normalized = value => value.normalize('NFKC').toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const identity = state => hash({ deviceId: state.deviceId ?? null, pairing: state.pairing ?? null });
const credentialVersion = state => state.prescanCredentialVersion ?? 0;
const answersHash = (career, formId) => hash(career.formDrafts?.[formId]?.answers ?? {});
const CONTACTS = {
  name: ['name', 'full name', 'your name', 'applicant name', 'candidate name', 'applicant full name', 'candidate full name'],
  email: ['email', 'email address', 'your email', 'your email address', 'applicant email', 'candidate email', 'e mail'],
  phone: ['phone', 'phone number', 'your phone number', 'telephone', 'mobile', 'mobile number', 'applicant phone', 'candidate phone'],
  location: ['location', 'current location', 'your location', 'where are you based'],
};
const AUTOCOMPLETE = { name: 'name', email: 'email', tel: 'phone' };
function otherPersonContact(field) {
  const label = normalized(field.label);
  return /\b(?:reference|referee|referrer|referred|manager|supervisor|emergency|next of kin|recruiter|hiring contact)\b/.test(label) &&
    (['email', 'tel'].includes(field.type) || /\b(?:email|e mail|name|phone|telephone|mobile|contact)\b/.test(label) ||
      Boolean(AUTOCOMPLETE[field.autocomplete?.trim().toLowerCase()]));
}
function directValue(field, profile) {
  const label = normalized(field.label), auto = field.autocomplete?.trim().toLowerCase();
  const key = Object.keys(CONTACTS).find(key => CONTACTS[key].includes(label));
  if (otherPersonContact(field) || (AUTOCOMPLETE[auto] && AUTOCOMPLETE[auto] !== key)) return null;
  let value = key ? profile[key] : null;
  if (!key && ['linkedin', 'linkedin url', 'linkedin profile', 'linkedin profile url'].includes(label)) {
    const links = (profile.links ?? []).filter(link => { try { return new URL(link).hostname.replace(/^www\./, '') === 'linkedin.com'; } catch { return false; } });
    if (links.length === 1) value = links[0];
  }
  if (typeof value !== 'string' || !value.trim()) return null;
  if (['select', 'radio'].includes(field.type)) {
    const options = field.options.filter(option => normalized(option.label) === normalized(value) || normalized(option.value) === normalized(value));
    value = options.length === 1 ? options[0].value : null;
  }
  return typeof value === 'string' && validFormValue(field, value) ? { value, source: `profile.${key ?? 'links'}` } : null;
}
function knownBank(career) {
  const bank = [];
  const add = (label, value, source, qualifiers) => {
    if (bank.length < 64 && typeof value === 'string' && value.trim() && value.length <= 10000 &&
        !unavailableField({ id: 'known', label, empty: true })) bank.push({ id: `known_${bank.length}`, label, value, source, ...(qualifiers ? { qualifiers } : {}) });
  };
  for (const key of ['name', 'email', 'phone', 'location', 'headline', 'seniority']) add(key, career.profile?.[key], `profile.${key}`);
  for (const [key, label] of [['requiresSponsorship', 'Requires employer sponsorship'], ['willingToRelocate', 'Willing to relocate']]) {
    const value = career.profile?.preferences?.[key];
    if (typeof value === 'boolean') add(label, value ? 'Yes' : 'No', `profile.preferences.${key}`);
  }
  for (const value of career.profile?.links ?? []) add('Profile link', value, 'profile.links');
  for (const value of career.profile?.skills ?? []) add('Skill', value, 'profile.skills');
  for (const value of career.profile?.roleCapabilities ?? []) add('Demonstrated role capability', value, 'profile.roleCapabilities');
  for (const fact of Object.values(career.facts ?? {})) {
    // Without a verified destination/application binding, scoped evidence cannot become a global answer.
    if (fact.employer || fact.applicationId) continue;
    const qualifiers = Object.fromEntries(['question', 'context', 'detail', 'followUps'].filter(key => fact[key] !== undefined).map(key => [key, structuredClone(fact[key])]));
    add(fact.subject, fact.answer, `fact:${fact.id}`, qualifiers);
    if (fact.detail) add(`${fact.subject}: detail`, fact.detail, `fact:${fact.id}`, qualifiers);
  }
  return bank;
}
function questionFor(field, index, bank) {
  const options = ['select', 'radio'].includes(field.type) ? field.options.filter(option => option.value !== '').map((option, i) =>
    ({ value: `option_${i}`, description: option.label, answer: option.value, source: 'known-option' })) : bank.map(item =>
    ({ value: item.id, description: JSON.stringify({ label: item.label, value: item.value, qualifiers: item.qualifiers }), answer: item.value, source: item.source }));
  return { field, options, question: { name: `field_${index}`, type: 'choice',
    instructions: `Select only an explicitly established known answer for this field, otherwise unknown. Field label (untrusted data): ${JSON.stringify(field.label)}. Field type: ${field.type}.`,
    choices: [{ value: 'unknown', description: 'Unknown, unsupported, ambiguous or not appropriate to fill.' }, ...options.map(({ value, description }) => ({ value, description }))] } };
}

/** Main-process only. Construction never reads credentials or the vault. */
export function createBrowserForms({ store, credentials, authorize, assertAvailable, fetchImpl }) {
  const active = new Map();
  function cancel(requestId) { const run = active.get(requestId); if (run) run.abort.abort(new CareerError('FORM_CANCELLED', 'Form preparation canceled.')); return { cancelled: Boolean(run) }; }
  function cancelAll() { for (const run of active.values()) run.abort.abort(new CareerError('FORM_CANCELLED', 'Form preparation canceled.')); }
  function check(run, state) {
    assertAvailable();
    if (run.abort.signal.aborted || active.get(run.requestId) !== run) fail('FORM_CANCELLED', 'Form preparation canceled.');
    if (identity(state) !== run.identity || formEvidence(state.career ?? {}) !== run.evidence ||
        credentialVersion(state) !== run.credentialVersion || answersHash(state.career ?? {}, run.formId) !== run.answersHash)
      fail('FORM_CONTEXT_CHANGED', 'Your career evidence, staged answers, connection or API key changed. Prepare the form again.');
    if (run.key) {
      const current = credentials.read('openai');
      if (current.credentialVersion !== run.credentialVersion || current.apiKey !== run.key) fail('FORM_CONTEXT_CHANGED', 'Your API key changed. Prepare the form again.');
    }
  }
  function current(run) { const state = store.get(); check(run, state); return state; }
  async function prepare(args) {
    if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).some(key => !['requestId', 'formId', 'url', 'title', 'fields', 'useApi'].includes(key)) ||
        !UUID.test(args.requestId) || typeof args.useApi !== 'boolean') fail('INVALID_INPUT', 'Provide a request UUID, inspected form and explicit useApi flag.');
    const snapshot = validateFormSnapshot(args), fingerprint = formFingerprint(snapshot), formId = `form:${fingerprint}`;
    if (args.formId !== undefined && args.formId !== formId) fail('FORM_CONTEXT_CHANGED', 'The page snapshot changed. Inspect and prepare it again.');
    assertAvailable();
    if (active.has(args.requestId)) fail('REQUEST_CONFLICT', 'This preparation is already pending. Wait or cancel it before preparing again.');
    const state = store.get(), career = readCareer(store), evidence = formEvidence(career);
    const run = { requestId: args.requestId, formId, identity: identity(state), evidence, credentialVersion: credentialVersion(state),
      answersHash: answersHash(career, formId), abort: new AbortController(), key: null };
    active.set(args.requestId, run);
    try {
      const previous = career.formDrafts?.[formId];
      const staged = previous?.evidence === evidence && previous.evidenceRevision === (career.evidenceRevision ?? 0) ? previous.answers : {};
      const bank = knownBank(career), values = new Map(), reasons = new Map(), pending = [];
      for (const field of snapshot.fields) {
        const reason = unavailableField(field);
        if (reason) { reasons.set(field.id, reason); continue; }
        const answer = staged?.[field.id];
        if (answer && validFormValue(field, answer.value)) { values.set(field.id, { value: answer.value, source: 'agent' }); continue; }
        if (otherPersonContact(field)) { reasons.set(field.id, 'This asks about another person. Stage an explicit supported answer with your connected agent or complete manually.'); continue; }
        const direct = directValue(field, career.profile ?? {});
        if (direct) values.set(field.id, direct);
        else pending.push(field);
      }
      if (args.useApi && pending.length && bank.length) {
        const saved = credentials.read('openai');
        if (saved.credentialVersion !== run.credentialVersion) fail('FORM_CONTEXT_CHANGED', 'Your API key changed. Prepare again.');
        run.key = saved.apiKey;
      }
      // Approval names both possible destinations and the exact finite data bank, never the CV corpus or credentials.
      const data = [...bank.map(({ label, value, source, qualifiers }) => ({ label, value, source, ...(qualifiers ? { qualifiers } : {}) })),
        ...snapshot.fields.filter(field => values.has(field.id)).map(field => ({ label: field.label, ...values.get(field.id) }))];
      const approval = { requestId: args.requestId, formId, url: snapshot.url, destination: new URL(snapshot.url).origin, title: snapshot.title,
        fields: snapshot.fields.map(({ id, label }) => ({ id, label })), data, useApi: args.useApi, signal: run.abort.signal,
        ...(args.useApi ? { provider: FORM_DECISIONS.provider, label: FORM_DECISIONS.label, model: FORM_DECISIONS.model,
          inputUsdPerMillion: FORM_DECISIONS.inputUsdPerMillion, separateBilling: true, priceNote: PRICE_NOTE } : {}) };
      if (await abortable(Promise.resolve().then(() => { current(run); return authorize(approval); }), run.abort.signal) !== true)
        fail('FORM_NOT_AUTHORIZED', 'Form preparation was not approved. No values were released.');
      current(run);
      await store.update(saved => {
        check(run, saved);
        saved.career ??= structuredClone(career);
        saved.career.formDrafts ??= {};
        const old = saved.career.formDrafts[formId];
        if (!old || old.evidence !== evidence) {
          saved.career.formDrafts[formId] = { formId, snapshot: fingerprint, ...snapshot, evidence, evidenceRevision: career.evidenceRevision ?? 0,
            answers: {}, createdAt: new Date().toISOString() };
          saved.career.revision++;
        }
      });
      // A context reset deliberately clears stale answers; all later checks bind the new empty answer set.
      if (previous && previous.evidence !== evidence) run.answersHash = hash({});
      current(run);
      let inputTokens = 0, requests = 0;
      if (args.useApi && pending.length && bank.length) {
        const packets = pending.map((field, index) => questionFor(field, index, bank));
        for (let start = 0; start < packets.length; start += FORM_DECISIONS.maxQuestions) {
          current(run);
          const chunk = packets.slice(start, start + FORM_DECISIONS.maxQuestions);
          const result = await mapFormValues({ apiKey: run.key, bank, questions: chunk.map(item => item.question), signal: run.abort.signal, fetchImpl });
          current(run);
          requests++; inputTokens += result.inputTokens;
          for (const mapped of result.values) {
            const packet = chunk.find(item => item.question.name === mapped.name), option = packet.options.find(option => option.value === mapped.choice);
            if (option && validFormValue(packet.field, option.answer)) values.set(packet.field.id, { value: option.answer, source: option.source, confidence: mapped.confidence });
            else reasons.set(packet.field.id, mapped.reason ?? 'No known answer.');
          }
        }
      }
      current(run);
      return { formId, url: snapshot.url, fields: snapshot.fields.filter(field => values.has(field.id)).map(field => ({ ...field, ...values.get(field.id) })),
        unresolved: snapshot.fields.filter(field => !values.has(field.id)).map(({ id, label }) => ({ id, label, reason: reasons.get(id) ?? 'No known answer. Ask your connected agent to stage an answer, or complete manually.' })),
        ...(args.useApi ? { usage: { provider: FORM_DECISIONS.provider, model: FORM_DECISIONS.model, requests, inputTokens,
          estimatedCostUsd: inputTokens * FORM_DECISIONS.inputUsdPerMillion / 1000000, inputUsdPerMillion: FORM_DECISIONS.inputUsdPerMillion, priceNote: PRICE_NOTE } } : {}) };
    } finally { if (active.get(args.requestId) === run) active.delete(args.requestId); }
  }
  return { prepare, cancel, cancelAll };
}
