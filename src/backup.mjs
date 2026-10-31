import { createHash, randomUUID } from 'node:crypto';
import { open, lstat, writeFile, rename, unlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { privateDirectory } from './vault.mjs';
import { assertPrivatePath, protectPrivatePath } from './platform-runtime.cjs';
import { createDocumentFiles, validExport, exportTypes, documentURI, documentName } from './mcp/files.mjs';
import { CAREER_SCHEMA, fail, hash, upgradeCareer } from './mcp/state.mjs';
import { BLOCK_KINDS } from './mcp/blocklist.mjs';
import { FACT_KINDS } from './mcp/facts.mjs';
import { applicationContextFingerprint } from './application-workflow.mjs';
import { replayProgress } from './application-progress.mjs';

export const BACKUP_VERSION = 2;
export const MAX_BACKUP_BYTES = 128 * 1024 * 1024;
const MAX_NODES = 1_000_000, MAX_PROFILES = 100, MAX_FILES = 2000;
const legacyExportURI = /^recruiters:\/\/exports\/([a-f0-9]{64})\.(pdf|csv|txt)$/;
const exportURI = { exec: uri => documentURI.exec(uri) ?? legacyExportURI.exec(uri), test: uri => documentURI.test(uri) || legacyExportURI.test(uri) };
const validDigest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const forbidden = new Set(['__proto__', 'prototype', 'constructor']);
const secrets = new Set(['privateKey', 'publicKey', 'prescanCredentials', 'apiKey', 'accessToken', 'refreshToken']);
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const invalid = detail => fail('INVALID_INPUT', `This backup cannot be restored: ${detail}. Your current profile has not changed.`);
const object = (value, label) => { if (!record(value)) invalid(`${label} must be an object`); return value; };
const array = (value, label) => { if (!Array.isArray(value)) invalid(`${label} must be a list`); return value; };
const text = (value, label) => { if (typeof value !== 'string') invalid(`${label} must be text`); };
const integer = (value, label) => { if (!Number.isSafeInteger(value) || value < 0 || value >= Number.MAX_SAFE_INTEGER) invalid(`${label} must be a nonnegative whole number`); };
// Keep ample arithmetic headroom for saved counters that consumers increment without a migration.
const counter = (value, label) => { integer(value, label); if (value > Math.floor(Number.MAX_SAFE_INTEGER / 2)) invalid(`${label} is too large to update safely`); };
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

function walk(value, visit, depth = 0, budget = { nodes: 0 }) {
  if (++budget.nodes > MAX_NODES || depth > 64) invalid('the file contains too many records or nested levels');
  if (value === null || typeof value !== 'object') return;
  if (!Array.isArray(value)) visit(value);
  for (const [key, child] of Object.entries(value)) {
    if (forbidden.has(key)) invalid('the file contains an unsafe field');
    walk(child, visit, depth + 1, budget);
  }
}
function entries(value, label, check) {
  for (const [id, item] of Object.entries(object(value, label))) { object(item, label); check(item, id); }
}
function strings(value, label) { for (const item of array(value, label)) text(item, label); }
function optionalText(value, keys) { for (const key of keys) if (value[key] != null) text(value[key], key); }
function job(value, { captured = false } = {}) {
  object(value, 'job');
  optionalText(value, ['id', 'title', 'company', 'url', 'applyUrl', 'originalUrl', 'location', 'classification', 'updatedAt', 'createdAt']);
  if (value.aliases !== undefined) strings(value.aliases, 'job links');
  if (value.description != null && typeof value.description !== 'string') {
    if (captured) invalid('a captured job description must be text');
    object(value.description, 'job description');
  }
}
function draft(value, kind) {
  object(value, 'document draft'); counter(value.version, 'document version');
  if (kind === 'cover_letter') strings(value.paragraphs, 'letter paragraphs');
  else {
    const doc = object(value.document, 'CV document');
    text(doc.headline, 'CV headline'); text(doc.summary, 'CV summary');
    const claim = item => { object(item, 'CV claim'); text(item.text, 'CV claim'); const support = object(item.support, 'CV evidence'); for (const key of ['cv', 'facts']) if (support[key] !== undefined) strings(support[key], 'CV evidence'); };
    for (const item of array(doc.experience, 'CV experience')) {
      object(item, 'CV experience'); for (const key of ['employer', 'role', 'startDate', 'endDate']) text(item[key], key);
      for (const bullet of array(item.bullets, 'CV bullets')) claim(bullet);
    }
    if (doc.highlights !== undefined) array(doc.highlights, 'CV highlights').forEach(claim);
    for (const key of ['education', 'skills', 'languages', 'additional']) if (doc[key] !== undefined)
      for (const item of array(doc[key], key)) {
        object(item, key);
        const required = { education: ['institution'], skills: ['label'], languages: ['language', 'proficiency'], additional: ['title'] }[key];
        for (const field of required) text(item[field], field);
        for (const [field, fieldValue] of Object.entries(item)) {
          if (field === 'items') strings(fieldValue, key);
          else text(fieldValue, field);
        }
        if (['skills', 'additional'].includes(key)) strings(item.items, key);
      }
    if (doc.certifications !== undefined) strings(doc.certifications, 'certifications');
    if (value.presentation !== undefined) { object(value.presentation, 'CV presentation'); if (!['classic', 'modern'].includes(value.presentation.template) || !['A4', 'LETTER'].includes(value.presentation.paper)) invalid('the CV presentation is unsupported'); }
  }
}
function base64(value, maximum, label) {
  if (typeof value !== 'string' || !value.length || value.length > Math.ceil(maximum / 3) * 4 || value.length % 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) invalid(`${label} contains invalid file bytes`);
  const bytes = Buffer.from(value, 'base64');
  if (!bytes.length || bytes.length > maximum || bytes.toString('base64') !== value) invalid(`${label} contains invalid file bytes`);
  return bytes;
}

/** Validate containers before any consumer or destructive schema upgrade can see imported data. */
export function validateBackupCareer(career) {
  object(career, 'profile');
  if (career.version !== CAREER_SCHEMA) invalid(`career format ${String(career.version)} is unsupported; use a backup with career format ${CAREER_SCHEMA}`);
  walk(career, value => { for (const key of Object.keys(value)) if (secrets.has(key)) invalid('credentials are not profile data'); });
  integer(career.revision, 'profile revision'); counter(career.evidenceRevision, 'evidence revision');
  for (const key of ['rankingVersion']) if (career[key] !== undefined) counter(career[key], key);
  const profile = object(career.profile, 'profile details');
  for (const [key, value] of Object.entries(profile)) {
    if (['links', 'roleCapabilities', 'skills'].includes(key)) { if (value !== null) strings(value, key); }
    else if (['preferences', 'onboarding'].includes(key)) object(value, key);
    else if (value !== null) text(value, key);
  }
  if (profile.preferences) for (const [key, value] of Object.entries(profile.preferences)) {
    if (value === null) continue;
    if (key === 'careerPaths') for (const item of array(value, 'career paths')) {
      object(item, 'a career path'); text(item.name, 'a career path name'); strings(item.titles, 'career path titles'); text(item.why, 'a career path reason');
    }
    else if (Array.isArray(value)) strings(value, key);
    else if (!['string', 'number', 'boolean'].includes(typeof value)) invalid('preferences contain an invalid value');
  }
  entries(career.sources, 'CV sources', (source, id) => {
    if (source.id !== id) invalid('a CV source ID does not match its record');
    for (const key of ['name', 'text', 'mediaType', 'contentHash']) text(source[key], `source ${key}`);
    if (source.contentHash !== hash(source.text)) invalid('a saved CV text check failed');
    if (source.provenance !== undefined) object(source.provenance, 'CV source details');
    if (!['cv', 'supporting', 'interview'].includes(source.purpose)) invalid('a source purpose is unsupported');
    if (source.archived !== undefined && typeof source.archived !== 'boolean') invalid('a source archive flag is invalid');
    if (source.originalBase64 !== undefined) {
      const bytes = base64(source.originalBase64, 5 * 1024 * 1024, 'An original CV');
      if (source.mediaType === 'application/pdf' ? bytes.subarray(0, 5).toString() !== '%PDF-' : source.mediaType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ? bytes.subarray(0, 2).toString() !== 'PK' : source.mediaType === 'text/plain' ? !validExport(bytes, 'txt') : true) invalid('an original CV has an unsupported or mismatched file type');
    }
  });
  entries(career.facts, 'facts', (fact, id) => {
    if (fact.id !== id) invalid('a fact ID does not match its record');
    if (!FACT_KINDS.includes(fact.kind)) invalid('a fact kind is unsupported');
    for (const key of ['kind', 'subject', 'answer']) text(fact[key], `fact ${key}`);
    optionalText(fact, ['detail', 'employer', 'question', 'context', 'applicationId']);
    if (fact.followUps !== undefined) for (const exchange of array(fact.followUps, 'fact follow-ups')) { object(exchange, 'fact follow-up'); text(exchange.question, 'follow-up question'); text(exchange.answer, 'follow-up answer'); optionalText(exchange, ['context']); }
  });
  entries(career.applications, 'applications', (app, id) => {
    if (app.id !== id) invalid('an application ID does not match its record');
    job(app.job); text(app.job.title, 'job title'); text(app.createdAt, 'application date'); text(app.updatedAt, 'application date');
    for (const [key, history, kind] of [['cv', 'cvHistory', 'cv'], ['coverLetter', 'coverLetterHistory', 'cover_letter']]) {
      if (app[key] != null) draft(app[key], kind);
      for (const item of array(app[history], history)) draft(item, kind);
    }
    array(app.exports, 'saved documents').forEach(item => {
      object(item, 'saved document');
      if (item.uri !== undefined && (typeof item.uri !== 'string' || !exportURI.test(item.uri))) invalid('a saved document reference is invalid');
      if (item.textValidation != null) { object(item.textValidation, 'document text check'); if (typeof item.textValidation.passed !== 'boolean') invalid('a document text check is invalid'); }
    });
    if (app.formAnswers !== undefined) entries(app.formAnswers, 'saved answers', answer => { text(answer.value, 'saved answer'); });
    if (app.progress !== undefined) {
      object(app.progress, 'application progress');
      let replayed;
      try { replayed = replayProgress(app.progress.history); } catch { invalid('an application progress step is invalid'); }
      if (hash(replayed) !== hash(app.progress)) invalid('an application progress does not match its steps');
    }
  });
  object(career.receipts, 'request receipts');
  for (const key of ['jobs', 'blocklist', 'interviews', 'formDrafts', 'applicationBindings', 'applicationPreparations', 'reviewOverrides']) if (career[key] !== undefined) entries(career[key], key, () => {});
  if (career.jobs) entries(career.jobs, 'jobs', item => { job(item, { captured: true }); text(item.id, 'job ID'); text(item.title, 'job title'); text(item.updatedAt, 'job date'); });
  if (career.blocklist) entries(career.blocklist, 'blocked jobs', item => { if (!BLOCK_KINDS.includes(item.kind)) invalid('a blocked-job rule is unsupported'); text(item.value, 'blocked-job value'); });
  if (career.interviews) entries(career.interviews, 'interviews', item => {
    optionalText(item, ['id', 'title', 'applicationId', 'createdAt']);
    for (const question of array(item.questions, 'interview questions')) {
      object(question, 'interview question');
      optionalText(question, ['id', 'kind', 'subject', 'prompt', 'stage', 'employer', 'factId', 'factSnapshot', 'context']);
      if (question.options !== undefined) strings(question.options, 'interview options');
    }
  });
  if (career.formDrafts) entries(career.formDrafts, 'saved forms', item => {
    optionalText(item, ['formId', 'snapshot', 'url', 'title', 'createdAt', 'updatedAt', 'applicationId']);
    array(item.fields, 'form fields').forEach(field => {
      object(field, 'form field'); optionalText(field, ['id', 'type', 'label', 'name', 'value', 'signature']);
      if (field.options !== undefined) array(field.options, 'form choices').forEach(option => { object(option, 'form choice'); text(option.value, 'choice value'); text(option.label, 'choice label'); });
    });
    if (item.actions !== undefined) array(item.actions, 'form actions').forEach(action => object(action, 'form action'));
    entries(item.answers, 'form answers', answer => text(answer.value, 'form answer'));
  });
  if (career.matching !== undefined) {
    const matching = object(career.matching, 'job reviews');
    for (const key of ['jobs', 'scores', 'pairs']) if (matching[key] !== undefined) entries(matching[key], key, item => {
      if (key === 'jobs') job(item);
      if (key === 'scores') {
        optionalText(item, ['id', 'status', 'reason', 'profileVersion', 'policyId', 'scoredAt', 'relocation']);
        for (const field of ['gaps', 'strengths']) if (item[field] !== undefined) strings(item[field], field);
        if (item.requirements !== undefined) for (const requirement of array(item.requirements, 'requirements')) {
          object(requirement, 'requirement'); optionalText(requirement, ['requirement', 'status', 'reason', 'priority']);
          for (const field of ['factIds', 'cvQuotes']) if (requirement[field] !== undefined) strings(requirement[field], field);
        }
        for (const field of ['gates', 'dimensions']) if (item[field] !== undefined) {
          object(item[field], field);
          for (const value of Object.values(item[field])) if (value !== null && !['string', 'number'].includes(typeof value)) invalid(`a review ${field} value is invalid`);
        }
      }
      if (key === 'pairs') optionalText(item, ['a', 'b', 'preferred', 'reason', 'profileVersion', 'policyId', 'comparedAt']);
    });
  }
  if (career.introductions !== undefined) {
    const intro = object(career.introductions, 'CV sharing');
    if (intro.consent !== undefined) object(intro.consent, 'sharing choice');
    if (intro.documents !== undefined) entries(intro.documents, 'matched employment', item => {
      optionalText(item, ['contentHash', 'extractedAt', 'sharedAt', 'sharedHash', 'sharedContentHash', 'documentId', 'sharedAccountId']);
      if (item.remoteCopies !== undefined) for (const copy of array(item.remoteCopies, 'shared CV copies')) {
        object(copy, 'shared CV copy');
        if (typeof copy.documentId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(copy.documentId)) invalid('a shared CV document reference is invalid');
        if (copy.accountId !== undefined && (typeof copy.accountId !== 'string' || !copy.accountId.length || copy.accountId.length > 300)) invalid('a shared CV account reference is invalid');
      }
      for (const role of array(item.employment, 'employment')) {
        object(role, 'employment role'); for (const key of ['ref', 'name', 'title', 'startDate']) text(role[key], key);
        optionalText(role, ['endDate']); if (typeof role.current !== 'boolean') invalid('an employment date is invalid');
      }
    });
  }
  for (const key of ['prescan', 'prescanInclusion', 'prescanPublicationRange']) if (career[key] !== undefined && career[key] !== null && typeof career[key] !== 'string') object(career[key], key);
  return career;
}

function references(career) {
  const refs = [];
  walk(career, value => {
    // Old paths are never opened, copied, or trusted, including receipt copies.
    if (Object.hasOwn(value, 'path')) delete value.path;
    if (typeof value.uri === 'string' && /^recruiters:\/\/(?:exports|documents)\//.test(value.uri)) {
      const match = exportURI.exec(value.uri), legacy = legacyExportURI.exec(value.uri);
      if (!match || (value.sha256 !== undefined && (!validDigest(value.sha256) || (legacy && value.sha256 !== legacy[1]))) ||
        (value.mediaType !== undefined && value.mediaType !== exportTypes[match[2]])) invalid('a saved document reference is invalid');
      refs.push(value);
    } else if (value.uri !== undefined && (value.sha256 !== undefined || value.documentVersion !== undefined)) invalid('a saved document reference is not a local export');
  });
  return refs;
}
function invalidateRuntime(career, consent) {
  career.receipts = {};
  delete career.applicationBindings; delete career.applicationPreparations;
  for (const form of Object.values(career.formDrafts ?? {})) { form.evidence = ''; delete form.applicationContext; }
  career.introductions ??= {};
  delete career.introductions.consent;
  if (consent !== undefined) career.introductions.consent = structuredClone(consent);
  // Remote references are untrusted deletion provenance, not permission or a claim that this account has shared the CV.
  for (const item of Object.values(career.introductions.documents ?? {})) { delete item.sharedAt; delete item.sharedHash; }
}
const profileName = (career, account, fallback) => (career.profile.name?.trim() || (typeof account?.label === 'string' && account.label.trim()) || fallback).slice(0, 300);
const counts = career => ({ cvs: Object.values(career.sources).filter(source => source.purpose === 'cv' && !source.archived).length, facts: Object.keys(career.facts).length, jobs: new Set([...Object.keys(career.jobs ?? {}), ...Object.keys(career.matching?.jobs ?? {})]).size, applications: Object.keys(career.applications).length });
const missingWarning = count => `${count} saved document file${count === 1 ? ' is' : 's are'} missing. The saved drafts are included, but these files will need to be saved again.`;

export function parseBackup(json) {
  if (typeof json !== 'string' || Buffer.byteLength(json) > MAX_BACKUP_BYTES) invalid('choose a JSON file no larger than 128 MiB');
  let data;
  try { data = JSON.parse(json); } catch { invalid('the file is not valid JSON'); }
  object(data, 'backup'); walk(data, () => {});
  if (![1, BACKUP_VERSION].includes(data.version)) invalid('this backup version is unsupported');
  if (typeof data.exportedAt !== 'string' || data.exportedAt.length > 40 || !Number.isFinite(Date.parse(data.exportedAt))) invalid('the backup date is invalid');
  let profiles;
  if (data.version === 1) {
    const archives = array(data.archives ?? [], 'archived profiles');
    if (archives.length >= MAX_PROFILES) invalid('there are too many archived profiles');
    profiles = [{ id: 'current', career: data.career, account: data.account }, ...archives.map((item, index) => ({ id: `archive-${index + 1}`, career: object(item, 'archived profile').career, account: item.account }))];
  } else profiles = array(data.profiles, 'profiles');
  if (!profiles.length || profiles.length > MAX_PROFILES) invalid('the number of profiles is unsupported');
  const files = new Map();
  if (data.version === BACKUP_VERSION) {
    const saved = array(data.files, 'document files');
    if (saved.length > MAX_FILES) invalid('there are too many document files');
    for (const file of saved) {
      object(file, 'document file'); const match = typeof file.uri === 'string' && exportURI.exec(file.uri);
      if (!match || files.has(file.uri) || !validDigest(file.sha256) || (legacyExportURI.test(file.uri) && file.sha256 !== match[1]) || file.mediaType !== exportTypes[match[2]]) invalid('a document file reference is invalid');
      const bytes = base64(file.base64, 12 * 1024 * 1024, 'A saved document');
      if (bytes.length !== file.bytes || digest(bytes) !== file.sha256 || !validExport(bytes, match[2])) invalid('a saved document failed its file check');
      files.set(file.uri, file);
    }
  }
  const ids = new Set();
  profiles = profiles.map((item, index) => {
    object(item, 'profile');
    if (item.account != null) object(item.account, 'account label');
    if (item.name !== undefined) text(item.name, 'profile name');
    if (typeof item.id !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(item.id) || ids.has(item.id)) invalid('a profile ID is invalid');
    ids.add(item.id);
    const career = validateBackupCareer(item.career), refs = references(career), warnings = [];
    const missing = new Set(data.version === 1 ? refs.map(ref => ref.uri) : array(item.missingFiles ?? [], 'missing files'));
    for (const uri of missing) if (typeof uri !== 'string' || !exportURI.test(uri) || files.has(uri)) invalid('a missing document reference is invalid');
    for (const ref of refs) {
      const file = files.get(ref.uri);
      if (!file) {
        if (!missing.has(ref.uri)) invalid('a saved document is absent from the backup');
        delete ref.uri; ref.unavailable = true;
      } else if ((ref.bytes !== undefined && ref.bytes !== file.bytes) || (ref.sha256 !== undefined && ref.sha256 !== file.sha256)) invalid('a saved document does not match its file');
    }
    for (const app of Object.values(career.applications)) for (const file of app.exports) if (!file.uri) file.unavailable = true;
    // Only actual application records supply naming and ownership. Never restore a raw path or guess a candidate.
    for (const app of Object.values(career.applications)) for (const ref of app.exports) {
      if (!ref.uri || ref.uri.endsWith('.csv')) continue;
      try {
        documentName(career.profile.name); documentName(app.job.company); documentName(app.job.title);
        if (!['cv', 'cover_letter'].includes(ref.kind)) throw new Error('Unbound document');
      } catch {
        missing.add(ref.uri); delete ref.uri; ref.unavailable = true;
      }
    }
    if (data.version === 1) warnings.push('This older backup does not include saved PDF, TXT or CSV files. Saved drafts and any original CV files in the backup are included.');
    else {
      const unbound = Object.values(career.applications).flatMap(app => app.exports).filter(file => !file.uri).length;
      if (missing.size || unbound) warnings.push(missingWarning(Math.max(missing.size, unbound)));
    }
    const originalsMissing = Object.values(career.sources).filter(source => source.provenance?.kind === 'native_file' && !source.originalBase64).length;
    if (originalsMissing) warnings.push(`${originalsMissing} original CV file${originalsMissing === 1 ? ' is' : 's are'} missing. The saved CV text is included.`);
    invalidateRuntime(career);
    return { id: item.id, name: profileName(career, item.account, typeof item.name === 'string' ? item.name.slice(0, 300) : index ? `Saved profile ${index}` : 'Current profile'), career, warnings };
  });
  return { exportedAt: data.exportedAt, profiles, files };
}

async function readSelectedBackup(filename) {
  const info = await lstat(filename);
  if (!info.isFile() || info.isSymbolicLink() || info.size < 1 || info.size > MAX_BACKUP_BYTES) invalid('choose a regular JSON file no larger than 128 MiB');
  const handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const current = await handle.stat();
    if (!current.isFile() || current.size < 1 || current.size > MAX_BACKUP_BYTES) invalid('choose a JSON file no larger than 128 MiB');
    // A growing file cannot make readFile allocate without a bound.
    const bytes = Buffer.alloc(current.size + 1);
    let length = 0;
    while (length < bytes.length) { const result = await handle.read(bytes, length, bytes.length - length, null); if (!result.bytesRead) break; length += result.bytesRead; }
    if (length !== current.size) invalid('the selected file changed; choose it again');
    try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length)); }
    catch { invalid('the file is not valid UTF-8 JSON'); }
  } finally { await handle.close(); }
}

async function writeBackup(filename, payload, beforeCommit = () => {}) {
  const json = JSON.stringify(payload);
  if (Buffer.byteLength(json) > MAX_BACKUP_BYTES) fail('BACKUP_LIMIT', 'This backup is larger than 128 MiB. No profile data was changed.');
  const temp = `${filename}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, json, { mode: 0o600, flag: 'wx' }); protectPrivatePath(temp);
    beforeCommit();
    await rename(temp, filename);
  } finally { await unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}

/** Native paths and full backup contents stay in this controller, never in renderer results. */
export function createBackups({ directory, store, selectBackup, selectDestination, openFolder, assertAvailable = () => {}, epoch = () => 0, exclusive = action => action(), onRestored = () => {}, saveFile = writeBackup }) {
  let staged, selection = 0;
  const folder = path.join(directory, 'backups');
  const context = state => hash({ deviceId: state.deviceId, pairing: state.pairing ?? null, reconnectAccount: state.reconnectAccount ?? null, career: state.career, epoch: epoch() });
  const check = expected => { assertAvailable(); if (context(store.get()) !== expected) fail('BACKUP_STALE', 'Your profile or sign-in changed. Choose the backup again before restoring.'); };
  async function privateFolder() {
    assertPrivatePath(directory, { directory: true, info: await lstat(directory) });
    try { assertPrivatePath(folder, { directory: true, info: await lstat(folder) }); }
    catch (error) { if (error.code !== 'ENOENT') throw error; await privateDirectory(folder); }
    assertPrivatePath(folder, { directory: true, info: await lstat(folder) });
    return folder;
  }
  async function collect(state, includeArchives) {
    const profiles = [], files = new Map(), warnings = [];
    let size = 0;
    const entries = [{ deviceId: state.deviceId, career: state.career, account: state.pairing?.account }, ...(includeArchives ? Object.entries(state.identityArchives ?? {}).map(([deviceId, item]) => ({ deviceId, career: item.career, account: item.pairing?.account })) : [])];
    if (entries.length > MAX_PROFILES) fail('BACKUP_LIMIT', 'There are too many saved profiles for one backup. No profile data was changed.');
    for (const [index, item] of entries.entries()) {
      const career = structuredClone(validateBackupCareer(item.career));
      const refs = references(career), missing = new Set();
      const localFiles = createDocumentFiles({ directory, store: { get: () => ({ deviceId: item.deviceId, career: item.career }) }, assertAvailable });
      for (const ref of refs) {
        if (files.has(ref.uri) || missing.has(ref.uri)) continue;
        try {
          const saved = await localFiles.readResource(ref.uri), bytes = saved.blob ? Buffer.from(saved.blob, 'base64') : Buffer.from(saved.text, 'utf8');
          const file = { uri: ref.uri, sha256: digest(bytes), mediaType: saved.mimeType, bytes: bytes.length, base64: bytes.toString('base64') };
          size += file.base64.length;
          if (files.size >= MAX_FILES || size > MAX_BACKUP_BYTES) fail('BACKUP_LIMIT', 'The saved document files are too large for one backup. No profile data was changed.');
          files.set(ref.uri, file);
        } catch (error) {
          if (!['ENOENT', 'EACCES', 'EPERM', 'ELOOP', 'ENOTDIR', 'EXPORT_CORRUPT', 'NOT_FOUND'].includes(error.code)) throw error;
          missing.add(ref.uri);
        }
      }
      // Request receipts and browser bindings are not portable authorities.
      invalidateRuntime(career);
      size += Buffer.byteLength(JSON.stringify(career));
      if (size > MAX_BACKUP_BYTES) fail('BACKUP_LIMIT', 'This backup is larger than 128 MiB. No profile data was changed.');
      const unbound = Object.values(career.applications).flatMap(app => app.exports).filter(file => !file.uri).length;
      if (unbound) warnings.push(missingWarning(unbound));
      const originalsMissing = Object.values(career.sources).filter(source => source.provenance?.kind === 'native_file' && !source.originalBase64).length;
      if (originalsMissing) warnings.push(`${originalsMissing} original CV file${originalsMissing === 1 ? ' is' : 's are'} missing. The saved CV text is included.`);
      profiles.push({ id: index ? `archive-${index}` : 'current', name: profileName(career, item.account, index ? `Saved profile ${index}` : 'Current profile'), career, missingFiles: [...missing] });
    }
    // A duplicate file may be available in a different archived identity.
    for (const profile of profiles) {
      profile.missingFiles = profile.missingFiles.filter(uri => !files.has(uri));
      if (profile.missingFiles.length) warnings.push(missingWarning(profile.missingFiles.length));
    }
    return { payload: { version: BACKUP_VERSION, exportedAt: new Date().toISOString(), profiles, files: [...files.values()] }, warnings };
  }
  return {
    async save() {
      assertAvailable();
      const session = state => hash({ deviceId: state.deviceId, pairing: state.pairing ?? null, reconnectAccount: state.reconnectAccount ?? null, epoch: epoch() });
      const initial = session(store.get());
      const checkSession = () => {
        assertAvailable();
        if (session(store.get()) !== initial) fail('BACKUP_STALE', 'Your sign-in or local session changed. Save the backup again.');
      };
      const defaultPath = path.join(await privateFolder(), `recruiters-backup-${new Date().toISOString().slice(0, 10)}.json`);
      const filename = await selectDestination(defaultPath);
      if (!filename) return { exported: false };
      checkSession();
      const snapshot = store.get();
      const result = await collect(snapshot, true); checkSession();
      await saveFile(filename, result.payload, checkSession); checkSession();
      return { exported: true, filename: path.basename(filename), ...(result.warnings.length ? { warnings: result.warnings } : {}) };
    },
    async preview() {
      assertAvailable(); staged = undefined; const token = ++selection, initial = context(store.get());
      const filename = await selectBackup();
      if (!filename || token !== selection) return { cancelled: true };
      check(initial);
      const parsed = parseBackup(await readSelectedBackup(filename)); check(initial);
      const { warnings: safetyWarnings } = await collect(store.get(), false); check(initial);
      if (token !== selection) return { cancelled: true };
      staged = { ...parsed, restoreId: randomUUID(), context: initial, safetyWarnings };
      return { restoreId: staged.restoreId, filename: path.basename(filename), exportedAt: parsed.exportedAt,
        profiles: parsed.profiles.map(({ id, name, career, warnings }) => ({ id, name, counts: counts(career),
          warnings: [...warnings, ...safetyWarnings.map(warning => `About the safety copy of your current profile: ${warning}`)] })) };
    },
    cancel() { selection++; staged = undefined; return { cancelled: true }; },
    async restore({ restoreId, profileId }, operation) {
      assertAvailable();
      const selected = staged;
      if (!selected || selected.restoreId !== restoreId) fail('BACKUP_STALE', 'Choose the backup again before restoring.');
      const profile = selected.profiles.find(item => item.id === profileId);
      if (!profile) fail('INVALID_INPUT', 'Choose one of the profiles shown in this backup.');
      staged = undefined; selection++;
      return exclusive(async () => {
        check(selected.context);
        const createdFiles = new Set();
        const previousRecords = Object.values(store.get().career.applications ?? {}).flatMap(app => app.exports ?? []);
        let materializing;
        const localFiles = createDocumentFiles({ directory, store: { get: () => materializing ?? store.get() }, assertAvailable,
          onCreated: filename => createdFiles.add(filename) });
        try {
          await localFiles.withExportTransaction(() => store.update(async state => {
            check(selected.context);
            if (context(state) !== selected.context) fail('BACKUP_STALE', 'Your profile changed. Choose the backup again before restoring.');
            counter(state.career.revision, 'current profile revision');
            const revision = state.career.revision + 1;
            const safety = await collect(state, false);
            if (hash(safety.warnings) !== hash(selected.safetyWarnings)) fail('BACKUP_STALE', 'Your saved files changed. Choose the backup again before restoring.');
            await saveFile(path.join(await privateFolder(), `before-restore-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}.json`), safety.payload);
            check(selected.context);
            const career = structuredClone(profile.career);
            materializing = { deviceId: state.deviceId, career };
            for (const app of Object.values(career.applications)) {
              const current = new Map();
              for (const ref of app.exports) {
                for (const field of ['folderNumber', 'companyLimit', 'jobLimit']) delete ref[field];
                if (!ref.uri || ref.uri.endsWith('.csv')) continue;
                const draft = ref.kind === 'cv' ? app.cv : app.coverLetter;
                if (draft && (ref.documentVersion !== draft.version || (draft.contextFingerprint &&
                  (ref.contextFingerprint !== draft.contextFingerprint || draft.contextFingerprint !== applicationContextFingerprint(career, app))))) continue;
                const key = `${ref.kind}:${ref.format ?? (ref.uri.endsWith('.txt') ? 'txt' : 'pdf')}`;
                const previous = current.get(key);
                if (!previous || (ref.documentVersion ?? 0) >= (previous.documentVersion ?? 0)) current.set(key, ref);
              }
              const selectedDocuments = new Set(current.values());
              for (const ref of app.exports) {
                if (!ref.uri || ref.uri.endsWith('.csv')) continue;
                if (!selectedDocuments.has(ref)) { delete ref.uri; ref.unavailable = true; continue; }
                // Only this device's prior application may reserve an existing readable folder.
                const prior = [...(state.career.applications[app.id]?.exports ?? [])].reverse().find(item =>
                  item.applicationId === app.id && item.company === app.job.company && item.jobTitle === app.job.title && Number.isSafeInteger(item.folderNumber));
                if (prior) for (const field of ['folderNumber', 'companyLimit', 'jobLimit', 'company', 'jobTitle', 'applicationId']) ref[field] = prior[field];
              }
            }
            const owned = new Map(Object.values(career.applications).flatMap(app => app.exports.map(ref => [ref, app])));
            const reboundRankings = new Map();
            for (const ref of references(career)) {
              const file = selected.files.get(ref.uri);
              if (!file) invalid('a saved document is unavailable');
              const app = owned.get(ref);
              if (file.mediaType !== 'text/csv' && !app) { delete ref.uri; ref.unavailable = true; continue; }
              let exported = file.mediaType === 'text/csv' ? reboundRankings.get(ref.uri) : null;
              if (!exported) exported = await localFiles.exportDocument({ bytes: Buffer.from(file.base64, 'base64'), mediaType: file.mediaType,
                applicationId: app?.id, kind: ref.kind, documentVersion: ref.documentVersion });
              if (file.mediaType === 'text/csv') reboundRankings.set(ref.uri, exported);
              Object.assign(ref, exported); delete ref.unavailable;
            }
            check(selected.context);
            invalidateRuntime(career, state.career.introductions?.consent);
            career.revision = revision;
            state.career = upgradeCareer(career);
          }, { beforeCommit: () => check(selected.context) }));
        } catch (error) {
          // The exclusive gate remains closed through rollback; only files opened with wx by this attempt are removed.
          await Promise.all([...createdFiles].map(filename => unlink(filename).catch(cleanup => { if (cleanup.code !== 'ENOENT') throw cleanup; })));
          throw error;
        }
        onRestored();
        const result = { restored: true, profileName: profile.name, safetyBackupSaved: true };
        try { await createDocumentFiles({ directory, store, assertAvailable }).cleanupExports(previousRecords); }
        catch { result.cleanupWarning = 'Your profile was restored, but some obsolete generated files could not be removed.'; }
        return result;
      }, operation);
    },
    async openFolder() { assertAvailable(); const target = await privateFolder(); await openFolder(target); return { opened: true }; },
  };
}
