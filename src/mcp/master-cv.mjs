import { randomUUID } from 'node:crypto';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { fail, mutateCareer, mutationSchema, readCareer } from './state.mjs';
import { patchProfile, profileFields } from './profile-fields.mjs';
import { resolveCareerGaps, savedCareerGap } from './career-gap.mjs';
import { CV_WRITING_GUIDE } from './cv-writing-policy.mjs';

const object = (properties, required = Object.keys(properties)) => ({ type: 'object', properties, required, additionalProperties: false });
const text = maxLength => ({ type: 'string', minLength: 1, maxLength, pattern: '\\S' });
const date = { type: 'string', maxLength: 40, description: 'Use the precision known from the CV or candidate. Leave empty when unknown; never invent dates.' };
const array = (items, maxItems = 100) => ({ type: 'array', items, maxItems });
export const presentationSchema = object({ template: { enum: ['classic', 'modern'] }, paper: { enum: ['A4', 'LETTER'] } });
const gapSchema = object({ activity: text(80), place: text(80), description: text(200), startDate: date, endDate: date }, ['activity', 'startDate', 'endDate']);
export const cvDocumentSchema = object({
  headline: text(300), summary: text(2000), highlights: array(text(1500), 12),
  experience: array(object({ employer: text(300), role: text(300), location: text(300), startDate: date, endDate: date, bullets: array(text(1500), 20) }, ['employer', 'role', 'startDate', 'endDate', 'bullets']), 50),
  skills: array(object({ label: text(100), items: array(text(200), 60) }), 20),
  education: array(object({ institution: text(300), qualification: text(300), startDate: date, endDate: date, details: text(1500) }, ['institution']), 30),
  languages: array(object({ language: text(100), proficiency: text(100) }), 30),
  certifications: array(text(500), 40), additional: array(object({ title: text(100), items: array(text(1000), 30) }), 15), careerGaps: array(gapSchema, 5),
}, ['headline', 'summary', 'experience']);
const masterSaveSchema = object({ baseVersion: { type: 'integer', minimum: 0 }, document: cvDocumentSchema, presentation: presentationSchema }, ['baseVersion', 'document']);
const requiredContactKeys = ['name', 'email', 'phone', 'location', 'linkedinUrl', 'links'];
const contactKeys = [...requiredContactKeys, 'country', 'addressLine1', 'addressLine2', 'city', 'postalCode'];
const manualDocumentSchema = structuredClone(cvDocumentSchema);
function loosen(schema) {
  if (!schema || typeof schema !== 'object') return;
  if (schema.type === 'string') { delete schema.minLength; delete schema.pattern; }
  if (schema.items) loosen(schema.items);
  for (const child of Object.values(schema.properties ?? {})) loosen(child);
}
loosen(manualDocumentSchema);
const contactSchema = object(Object.fromEntries(contactKeys.map(key => [key, key === 'links' ? profileFields.links : { anyOf: [{ type: 'string', maxLength: profileFields[key].anyOf[0].maxLength }, { type: 'null' }] }])), requiredContactKeys);
const manualSaveSchema = object({ ...mutationSchema, baseVersion: { type: 'integer', minimum: 0 }, contact: contactSchema, document: manualDocumentSchema, presentation: presentationSchema });
export const masterExportSchema = object({ ...mutationSchema, baseVersion: { type: 'integer', minimum: 1 }, format: { enum: ['pdf', 'txt'] } });
const ajv = new Ajv({ strict: false });
addFormats(ajv);
const validDocument = ajv.compile(cvDocumentSchema);
const validManualDocument = ajv.compile(manualDocumentSchema);
const validSave = ajv.compile(masterSaveSchema);
const validManualSave = ajv.compile(manualSaveSchema);
const validExport = ajv.compile(masterExportSchema);
const validPresentation = ajv.compile(presentationSchema);
const defaultPresentation = Object.freeze({ template: 'classic', paper: 'A4' });
const activeSources = career => Object.values(career.sources ?? {}).filter(source => !source.archived && source.purpose === 'cv');
const sourceIds = career => activeSources(career).map(source => source.id).sort();
const contact = career => Object.fromEntries(contactKeys.map(key => [key, career.profile?.[key] ?? (key === 'links' ? [] : null)]));
function validate(valid, value, label) {
  if (!valid(value)) fail('INVALID_INPUT', `${label}: provide valid fields using the advertised schema. ${valid.errors?.[0]?.instancePath || ''}`);
}
function datePoint(value) {
  if (/^\d{4}(?:-(?:0[1-9]|1[0-2]))?$/.test(value)) return value;
  if (/^(present|current|now)$/i.test(value)) return 'present';
  const match = /^(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s*(\d{4})$/i.exec(value);
  if (!match) return null;
  const month = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'].indexOf(match[1].slice(0, 3).toLowerCase()) + 1;
  return `${match[2]}-${String(month).padStart(2, '0')}`;
}
export function masterCareerGaps(career, document = career.masterCv?.current?.document) {
  if (!savedCareerGap(career).enabled) return undefined;
  const roles = (document?.experience ?? []).map(role => ({ start: datePoint(role.startDate), end: datePoint(role.endDate) }));
  if (!roles.length || roles.some(role => !role.start || !role.end || role.start === 'present')) return undefined;
  roles.sort((a, b) => a.start.localeCompare(b.start));
  const gaps = [];
  const add = (start, end) => {
    try { gaps.push(...resolveCareerGaps(career, [{ start, end }])); }
    catch (error) { if (!['CAREER_GAP_TOO_SHORT', 'CAREER_GAP_OUT_OF_RANGE'].includes(error.code)) throw error; }
  };
  let end = roles[0].end;
  for (const role of roles.slice(1)) {
    if (end !== 'present' && role.start > end) add(end, role.start);
    if (end !== 'present' && (role.end === 'present' || role.end > end)) end = role.end;
  }
  if (end !== 'present') add(end, 'present');
  return gaps.length ? gaps.reverse().slice(0, 5) : undefined;
}
function withGaps(career, document) {
  const { careerGaps: _ignored, ...authored } = structuredClone(document), gaps = masterCareerGaps(career, authored);
  return { ...authored, ...(gaps ? { careerGaps: gaps } : {}) };
}
function currentStatus(career) {
  const master = career.masterCv?.current;
  if (!master) return 'missing';
  if (JSON.stringify(master.sourceIds ?? []) !== JSON.stringify(sourceIds(career))) return 'stale';
  if (!validDocument(master.document)) return 'draft';
  return 'ready';
}
export function masterCvState(career, identity = '') {
  const current = career.masterCv?.current;
  return { revision: career.revision, identity: typeof identity === 'function' ? identity() : identity,
    master: current ? { version: current.version, updatedAt: current.updatedAt, document: withGaps(career, current.document), presentation: structuredClone(current.presentation) } : null,
    contact: contact(career), status: currentStatus(career), userEdited: Boolean(current?.userEdited) };
}
export function assertMasterReady(career) {
  if (currentStatus(career) !== 'ready') fail('MASTER_NOT_READY', 'Read the original CVs, saved facts and current master, ask only genuinely missing questions, and save the master in this conversation before tailoring or exporting. Saved edits are preserved.');
  return { ...career.masterCv.current, document: withGaps(career, career.masterCv.current.document) };
}
function assertVersion(career, version) {
  if ((career.masterCv?.current?.version ?? 0) !== version) fail('VERSION_CONFLICT', 'The Master CV changed. Read the latest version and merge your edits; the saved document was not replaced.');
}
function storeMaster(career, { document, presentation, editedBy }) {
  const previous = career.masterCv?.current, timestamp = new Date().toISOString();
  if ((previous?.version ?? 0) >= Number.MAX_SAFE_INTEGER - 1) fail('VERSION_CONFLICT', 'The Master CV version limit was reached. Saved work is preserved; contact support before creating another version.');
  career.masterCv ??= { current: null, history: [] };
  if (previous) career.masterCv.history.push(structuredClone(previous));
  career.masterCv.current = { version: (previous?.version ?? 0) + 1, document: withGaps(career, document), presentation: structuredClone(presentation),
    sourceIds: editedBy === 'user' && previous ? [...(previous.sourceIds ?? [])] : sourceIds(career),
    editedBy, userEdited: editedBy === 'user' || Boolean(previous?.userEdited), createdAt: timestamp, updatedAt: timestamp };
  career.evidenceRevision = (career.evidenceRevision ?? 0) + 1;
}
export function createMasterCvTools({ store, identity = '' }) {
  return [
    { name: 'career_master_cv_read', description: 'Read the saved editable master, original CV list, facts and drafting guidance. If missing or stale, complete it automatically in the current conversation. Preserve existing user edits and ask only genuinely missing questions.', inputSchema: object({}), readOnly: true, invoke: () => {
      const career = readCareer(store);
      return { ...masterCvState(career, identity), guide: CV_WRITING_GUIDE,
        sources: activeSources(career).map(source => ({ id: source.id, name: source.name })), facts: structuredClone(Object.values(career.facts ?? {})) };
    } },
    { name: 'career_master_cv_save', description: 'Save a plain master CV after reading originals and known facts. Use the current baseVersion, preserve candidate edits, and leave unknown dates empty. No citations, claim IDs or review bookkeeping are required.', inputSchema: masterSaveSchema, readOnly: false, invoke: args => {
      validate(validSave, args, 'Master CV');
      const mutation = { requestId: randomUUID(), revision: readCareer(store).revision };
      return mutateCareer(store, mutation, 'career_master_cv_save', args, career => {
        assertVersion(career, args.baseVersion);
        storeMaster(career, { document: args.document, presentation: args.presentation ?? career.masterCv?.current?.presentation ?? defaultPresentation, editedBy: 'agent' });
        return masterCvState(career, identity);
      });
    } },
  ];
}
export async function saveManualMaster({ store, args, identity = '' }) {
  validate(validManualSave, args, 'Master CV editor');
  return mutateCareer(store, args, 'master-cv-save', args, career => {
    assertVersion(career, args.baseVersion);
    const patch = Object.fromEntries(contactKeys.filter(key => Object.hasOwn(args.contact, key)).map(key => [key, key === 'links' ? args.contact.links.map(link => link.trim()).filter(Boolean) : args.contact[key]?.trim() || null]));
    patchProfile(career, patch);
    storeMaster(career, { document: args.document, presentation: args.presentation, editedBy: 'user' });
    return masterCvState(career, identity);
  });
}
export function masterExportSnapshot(career, args) {
  validate(validExport, args, 'Master export');
  if (career.revision !== args.revision) fail('REVISION_CONFLICT', 'The career record changed. Read the current Master CV before exporting.');
  assertVersion(career, args.baseVersion);
  const master = assertMasterReady(career);
  return structuredClone({ version: master.version, revision: career.revision, document: master.document, presentation: master.presentation, contact: career.profile });
}
export function masterHeading(profile) {
  const values = [profile.email, profile.phone, profile.location, profile.addressLine1, profile.addressLine2, profile.city, profile.postalCode, profile.country, profile.linkedinUrl, ...(profile.links ?? [])].filter(value => typeof value === 'string' && value.trim()).map(value => value.trim());
  const name = profile.name || [profile.firstName, profile.lastName].filter(Boolean).join(' ') || profile.preferredName;
  return { ...(name?.trim() ? { name: name.trim() } : {}), ...(values.length ? { contact: [...new Set(values)].join(' · ') } : {}) };
}
export async function renderMaster(master, profile, documents, format) {
  if (!['pdf', 'txt'].includes(format)) fail('INVALID_INPUT', 'Choose PDF or TXT export.');
  const input = { document: master.document, heading: masterHeading(profile), presentation: master.presentation ?? defaultPresentation };
  const expectedText = documents.renderCareerCvText(input);
  if (format === 'txt') return { bytes: Buffer.from(expectedText, 'utf8'), mediaType: 'text/plain', expectedText, textValidation: null };
  const layout = await documents.measureCareerCvLayout(input);
  if (!layout.fits) fail('LAYOUT_OVERFLOW', layout.error || 'Shorten the Master CV before exporting so its text fits readably.');
  const bytes = await documents.renderCareerCvPdf(input);
  let textValidation;
  try { textValidation = await documents.validateCareerPdfText({ bytes, expectedText, pageNumberFooter: false }); }
  catch { fail('EXPORT_CORRUPT', 'The PDF text could not be read back. The Master CV remains saved.'); }
  if (!textValidation.passed) fail('EXPORT_CORRUPT', 'The PDF did not preserve the Master CV text and reading order. The Master CV remains saved.');
  return { bytes, mediaType: 'application/pdf', expectedText, textValidation };
}
export function validateMasterCareer(career) {
  if (career.masterCv === undefined) return career;
  const container = career.masterCv;
  if (!container || typeof container !== 'object' || !Array.isArray(container.history) || container.history.length > 10000 || !Object.hasOwn(container, 'current') || (!container.current && container.history.length)) fail('INVALID_INPUT', 'Invalid saved Master CV history.');
  let version = 0, userEdited = false;
  for (const master of [...container.history, ...(container.current ? [container.current] : [])]) {
    if (!Number.isSafeInteger(master.version) || master.version <= version || master.version >= Number.MAX_SAFE_INTEGER || !['agent', 'user'].includes(master.editedBy) || typeof master.userEdited !== 'boolean') fail('INVALID_INPUT', 'Invalid master version or ownership.');
    if ((userEdited || master.editedBy === 'user') && !master.userEdited) fail('INVALID_INPUT', 'Saved Master CV history cannot discard user ownership.');
    userEdited ||= master.userEdited;
    version = master.version;
    validate(validManualDocument, master.document, 'Saved master document');
    validate(validPresentation, master.presentation, 'Saved master presentation');
    if (!Array.isArray(master.sourceIds) || master.sourceIds.some(id => typeof id !== 'string') || new Set(master.sourceIds).size !== master.sourceIds.length) fail('INVALID_INPUT', 'Invalid saved original CV list.');
    for (const field of ['createdAt', 'updatedAt']) if (!Number.isFinite(Date.parse(master[field]))) fail('INVALID_INPUT', 'Invalid master save date.');
  }
  return career;
}
