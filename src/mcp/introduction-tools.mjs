import { createHash } from 'node:crypto';
import { createCareerState, fail, readCareer } from './state.mjs';

// CV sharing with JobStash. The connected agent extracts employers, titles and dates from a saved CV, matches them to
// JobStash profiles/organizations/projects through the companion's signed relay (unmatched employers are dropped), and,
// with standing consent plus a native approval for each upload, the companion sends the CV and matched roles to JobStash.
// Withdrawing consent stops future uploads only; it can be granted again at any time.
export const CONSENT_VERSION = 1;
export const SHARING_PURPOSE = 'JobStash attaches your CV and matched work history to your JobStash profile, so you are included when it launches direct introductions to people at companies, without recruiters.';
const SHAREABLE_TYPES = new Set(['application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document']);
const MAX_ORIGINAL_BYTES = 5 * 1024 * 1024;
const MAX_TEXT = 100_000;
const forbidden = new Set(['__proto__', 'prototype', 'constructor']);
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const object = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const text = maxLength => ({ type: 'string', minLength: 1, maxLength, pattern: '\\S' });
const partialDate = { type: 'string', pattern: '^\\d{4}(?:-(?:0[1-9]|1[0-2]))?$' };
const REF = /^(profile|organization|project):[1-9]\d{0,18}$/;
const roleSchema = object({
  ref: { type: 'string', pattern: REF.source }, name: text(200), title: text(200),
  startDate: partialDate, endDate: { anyOf: [partialDate, { type: 'null' }] }, current: { type: 'boolean' },
}, ['ref', 'name', 'title', 'startDate', 'endDate', 'current']);
const searchSchema = object({ queries: { type: 'array', minItems: 1, maxItems: 20, items: object({ name: text(200), website: text(300) }, ['name']) } }, ['queries']);

const state = career => record(career.introductions) ? career.introductions : {};
const cvSources = career => Object.values(career.sources ?? {}).filter(source => record(source) && source.purpose === 'cv' && !source.archived && typeof source.id === 'string');
const employmentHash = employment => createHash('sha256').update(JSON.stringify(employment)).digest('hex');

function sourceStatus(career, source) {
  const saved = state(career).documents?.[source.id];
  if (!record(saved) || saved.contentHash !== source.contentHash) return 'needs_extraction';
  return saved.sharedHash === employmentHash(saved.employment) && saved.sharedContentHash === source.contentHash ? 'shared' : 'ready_to_share';
}

/** What onboarding still needs for sharing: unprocessed CVs, an unanswered consent and an unanswered GitHub question. */
export function introductionsStatus(career) {
  const intro = state(career);
  const sources = cvSources(career).map(source => {
    const saved = state(career).documents?.[source.id];
    return { sourceId: source.id, name: source.name ?? 'CV', contentHash: source.contentHash, status: sourceStatus(career, source),
      roles: record(saved) && saved.contentHash === source.contentHash ? saved.employment.length : null,
      sharedAt: record(saved) ? saved.sharedAt ?? null : null };
  });
  return {
    consent: record(intro.consent) ? { granted: intro.consent.granted === true, at: intro.consent.at ?? null } : null,
    github: intro.githubSkipped ? 'skipped' : intro.githubRequestedAt ? 'requested' : null,
    sources, purpose: SHARING_PURPOSE,
  };
}

/** Grant or withdraw standing consent; a later grant re-enables sharing. */
export function setSharingConsent(career, granted) {
  if (typeof granted !== 'boolean') fail('INVALID_INPUT', 'Choose whether CV sharing is allowed.');
  const intro = career.introductions = record(career.introductions) ? career.introductions : {};
  intro.consent = { granted, version: CONSENT_VERSION, at: new Date().toISOString() };
  return intro.consent;
}

function currentSource(career, sourceId) {
  const source = typeof sourceId === 'string' && !forbidden.has(sourceId) ? cvSources(career).find(item => item.id === sourceId) : null;
  if (!source) fail('UNKNOWN_SOURCE', 'This is not a current saved CV. Read career_employment_status and use one of its sourceIds.');
  return source;
}

function validRoles(employment) {
  if (!Array.isArray(employment) || employment.length > 50) fail('INVALID_INPUT', 'Save at most 50 matched roles.');
  const keys = new Set();
  return employment.map((role, index) => {
    if (!record(role) || Object.keys(role).some(key => !Object.hasOwn(roleSchema.properties, key))) fail('INVALID_INPUT', `employment[${index}] uses unsupported fields.`);
    const { ref, name, title, startDate, endDate, current } = role;
    if (typeof ref !== 'string' || !REF.test(ref)) fail('INVALID_INPUT', `employment[${index}].ref must come from career_employer_search candidates.`);
    for (const [field, value] of [['name', name], ['title', title]])
      if (typeof value !== 'string' || !value.trim() || value.length > 200) fail('INVALID_INPUT', `employment[${index}].${field} must be 1–200 characters.`);
    if (typeof startDate !== 'string' || !new RegExp(partialDate.pattern).test(startDate)) fail('INVALID_INPUT', `employment[${index}].startDate must be YYYY or YYYY-MM; drop a role whose start year the CV does not give.`);
    if (endDate !== null && (typeof endDate !== 'string' || !new RegExp(partialDate.pattern).test(endDate))) fail('INVALID_INPUT', `employment[${index}].endDate must be YYYY, YYYY-MM or null.`);
    if (typeof current !== 'boolean') fail('INVALID_INPUT', `employment[${index}].current must be true or false.`);
    if (current && endDate !== null) fail('INVALID_INPUT', `employment[${index}]: a current role has endDate null.`);
    if (endDate && startDate.padEnd(7, '-01') > endDate.padEnd(7, '-12')) fail('INVALID_INPUT', `employment[${index}] ends before it starts.`);
    const key = [ref, title.trim(), startDate, endDate, current].join('\n');
    if (keys.has(key)) fail('INVALID_INPUT', `employment[${index}] repeats another role.`);
    keys.add(key);
    return { ref, name: name.trim(), title: title.trim(), startDate, endDate, current };
  });
}

function uploadDocument(source) {
  if (typeof source.originalBase64 === 'string' && SHAREABLE_TYPES.has(source.mediaType)) {
    if (Buffer.byteLength(source.originalBase64, 'base64') > MAX_ORIGINAL_BYTES) fail('CV_TOO_LARGE', 'JobStash accepts CV files up to 5 MiB. Import a smaller CV.');
    return { filename: (source.name ?? 'CV').replace(/[\\/]/g, '-').slice(0, 255), mediaType: source.mediaType, contentBase64: source.originalBase64 };
  }
  if (typeof source.text !== 'string' || !source.text.trim() || source.text.length > MAX_TEXT) fail('CV_UNAVAILABLE', 'This CV has no shareable PDF, DOCX or text content.');
  // JobStash accepts tab, CR and LF only; other control characters (e.g. PDF form feeds) become spaces.
  return { filename: (source.name ?? 'CV.txt').replace(/[\\/]/g, '-').slice(0, 255), mediaType: 'text/plain', text: source.text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ') };
}

export function createIntroductionTools({ store, platform, shareCv, confirm, openGithub }) {
  const update = change => { let result; return store.update(next => { result = change(next.career ??= createCareerState()); }).then(() => result); };
  return [
    {
      name: 'career_employment_status', readOnly: true, inputSchema: object({}),
      description: 'Read CV sharing state: standing consent, the GitHub onboarding answer, and each current saved CV with status needs_extraction, ready_to_share or shared. Call at the start of every session; for each needs_extraction CV, read the full CV with career_source_read and extract its employers.',
      async invoke() { return introductionsStatus(readCareer(store)); },
    },
    {
      name: 'career_employer_search', readOnly: true, inputSchema: searchSchema,
      description: 'Search JobStash for employers named in a CV: up to 20 {name, website?} queries, each answered with up to 5 candidates (profiles first) carrying ref, kind, name, aliases, website, match and parent profile. Read-only, through the paired account. Choose a candidate only when it clearly is the same employer; prefer a profile, otherwise its organization or project; leave anything uncertain unmatched.',
      async invoke(args = {}) {
        if (!record(args) || !Array.isArray(args.queries) || !args.queries.length || args.queries.length > 20)
          fail('INVALID_INPUT', 'Provide 1–20 employer queries.');
        return platform('employer_search', { queries: args.queries });
      },
    },
    {
      name: 'career_employment_save', readOnly: false,
      inputSchema: object({ sourceId: text(200), contentHash: text(200), employment: { type: 'array', maxItems: 50, items: roleSchema } }, ['sourceId', 'contentHash', 'employment']),
      description: 'Save the roles extracted from one CV that matched a JobStash entity: ref (from career_employer_search), name, title, startDate (required, YYYY or YYYY-MM; drop a role without a start year), endDate (YYYY, YYYY-MM or null when unknown; a current role has endDate null) and current. Drop every employer without a confident match; never guess a ref. contentHash must equal the CV contentHash from career_employment_status. Replaces earlier roles for that CV; nothing is sent until career_cv_share.',
      async invoke(args = {}) {
        const employment = validRoles(args.employment);
        return update(career => {
          const source = currentSource(career, args.sourceId);
          if (args.contentHash !== source.contentHash) fail('CV_CHANGED', 'This CV changed. Read career_employment_status and extract it again.');
          const intro = career.introductions = record(career.introductions) ? career.introductions : {};
          intro.documents = record(intro.documents) ? intro.documents : {};
          const previous = intro.documents[source.id];
          intro.documents[source.id] = { ...(record(previous) ? previous : {}), contentHash: source.contentHash, employment, extractedAt: new Date().toISOString() };
          return { sourceId: source.id, saved: employment.length, status: sourceStatus(career, source), consent: introductionsStatus(career).consent };
        });
      },
    },
    {
      name: 'career_introductions_update', readOnly: false,
      inputSchema: object({ consent: { type: 'boolean' }, githubSkipped: { type: 'boolean' } }),
      description: 'Record the candidate\'s own answers: consent (true/false) to sharing their CV and matched work history with JobStash, and githubSkipped when they have no open-source work or decline to link GitHub. Consent can be withdrawn and granted again; withdrawing stops future uploads only.',
      async invoke(args = {}) {
        if (!record(args) || (args.consent === undefined && args.githubSkipped === undefined)) fail('INVALID_INPUT', 'Provide consent or githubSkipped.');
        return update(career => {
          if (args.consent !== undefined) setSharingConsent(career, args.consent);
          if (args.githubSkipped !== undefined) {
            if (typeof args.githubSkipped !== 'boolean') fail('INVALID_INPUT', 'githubSkipped must be true or false.');
            const intro = career.introductions = record(career.introductions) ? career.introductions : {};
            intro.githubSkipped = args.githubSkipped;
          }
          return introductionsStatus(career);
        });
      },
    },
    {
      name: 'career_cv_share', readOnly: false, inputSchema: object({ sourceId: text(200) }, ['sourceId']),
      description: 'Send one CV and its saved matched roles to JobStash after standing consent. The companion asks the candidate to approve this upload natively; JobStash replaces the CV on their JobStash profile and replaces their CV-derived work history. Requires career_employment_save for the current CV first.',
      async invoke(args = {}) {
        const career = readCareer(store);
        const intro = state(career);
        if (intro.consent?.granted !== true) fail('CONSENT_REQUIRED', 'Ask the candidate whether JobStash may receive their CV and matched work history, and record the answer with career_introductions_update.');
        const source = currentSource(career, args.sourceId);
        const saved = intro.documents?.[source.id];
        if (!record(saved) || saved.contentHash !== source.contentHash) fail('EXTRACTION_REQUIRED', 'Extract and save this CV\'s matched roles with career_employment_save first.');
        const document = uploadDocument(source);
        const employers = [...new Set(saved.employment.map(role => role.name))];
        const allowed = await confirm('Share your CV with JobStash?',
          `${source.name ?? 'Your CV'} and ${saved.employment.length} matched ${saved.employment.length === 1 ? 'role' : 'roles'}${employers.length ? ` (${employers.slice(0, 6).join(', ')}${employers.length > 6 ? ', …' : ''})` : ''} go to JobStash. ${SHARING_PURPOSE}`);
        if (!allowed) fail('NOT_APPROVED', 'The candidate did not approve this upload. Nothing was sent.');
        const sharedAt = new Date().toISOString();
        const result = await shareCv({ document,
          employment: saved.employment.map(({ ref, title, startDate, endDate, current }) => ({ ref, title, startDate, endDate, current })),
          consent: { version: CONSENT_VERSION, grantedAt: intro.consent.at } });
        if (!record(result) || typeof result.documentId !== 'string') fail('SHARE_FAILED', 'JobStash did not confirm the upload. Try again.');
        await update(next => {
          const entry = next.introductions?.documents?.[source.id];
          // A CV or role change during the upload leaves the new state for a later share.
          if (entry && entry.contentHash === saved.contentHash && employmentHash(entry.employment) === employmentHash(saved.employment))
            Object.assign(entry, { sharedAt, documentId: result.documentId, sharedContentHash: saved.contentHash, sharedHash: employmentHash(saved.employment) });
        });
        return { shared: true, documentId: result.documentId, roles: result.employment ?? saved.employment.length, sharedAt };
      },
    },
    {
      name: 'account_github_connect', readOnly: false, inputSchema: object({}),
      description: 'Open the recruiters.rip account page where the candidate links GitHub through their sign-in (optional; for developers with open-source work, so JobStash can confirm those contributions are theirs). Afterwards call account_status and check platform.github.login before telling them it is linked.',
      async invoke() {
        await openGithub();
        await update(career => {
          const intro = career.introductions = record(career.introductions) ? career.introductions : {};
          intro.githubRequestedAt = new Date().toISOString();
        });
        return { opened: true, next: 'Ask the candidate to choose Link GitHub on the opened page, then call account_status to confirm platform.github.login.' };
      },
    },
  ];
}
