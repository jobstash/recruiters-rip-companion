import { randomUUID } from 'node:crypto';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { fail, hash, mutateCareer, mutationSchema, readCareer } from './state.mjs';
import { patchProfile, profileFields } from './profile-fields.mjs';
import { cvDocumentTexts, renderableCv, unsupportedNumbers } from './cv-quality.mjs';
import { careerGapBinding, resolveCareerGaps, savedCareerGap } from './career-gap.mjs';
import { CV_WRITING_GUIDE } from './cv-writing-policy.mjs';

const object = (properties, required = Object.keys(properties)) => ({ type: 'object', properties, required, additionalProperties: false });
const text = maxLength => ({ type: 'string', minLength: 1, maxLength, pattern: '\\S' });
const uuid = { type: 'string', format: 'uuid' };
const digest = { type: 'string', pattern: '^[a-f0-9]{64}$' };
const array = (items, maxItems = 100, minItems = 0) => ({ type: 'array', items, maxItems, minItems });
export const CV_REVIEW_FACETS = Object.freeze(['outcomes', 'growth', 'complex_scenario']);
export const sourceRefSchema = object({ sourceId: uuid, contentHash: digest, quote: text(20000) });
export const supportSchema = { ...object({ sources: array(sourceRefSchema, 30, 1), facts: { ...array(uuid, 50, 1), uniqueItems: true } }, []), minProperties: 1 };
export const presentationSchema = object({ template: { enum: ['classic', 'modern'] }, paper: { enum: ['A4', 'LETTER'] } });
const claimSchema = object({ id: uuid, text: text(1500), support: supportSchema });
const gapSchema = object({ activity: text(80), place: text(80), description: text(200), startDate: text(40), endDate: text(40) }, ['activity', 'startDate', 'endDate']);
export const cvDocumentSchema = object({
  headline: text(300), summary: text(2000), highlights: array(claimSchema, 12),
  experience: array(object({ roleId: uuid, employer: text(300), role: text(300), location: text(300), startDate: text(40), endDate: text(40), bullets: array(claimSchema, 20) }, ['roleId', 'employer', 'role', 'startDate', 'endDate', 'bullets']), 50),
  skills: array(object({ label: text(100), items: array(text(200), 60) }), 20),
  education: array(object({ institution: text(300), qualification: text(300), startDate: text(40), endDate: text(40), details: text(1500) }, ['institution']), 30),
  languages: array(object({ language: text(100), proficiency: text(100) }), 30),
  certifications: array(text(500), 40), additional: array(object({ title: text(100), items: array(text(1000), 30) }), 15), careerGaps: array(gapSchema, 5),
}, ['headline', 'summary', 'experience']);
export const documentEvidenceSchema = object({ headline: supportSchema, summary: supportSchema, sections: supportSchema });
const savedDocumentEvidenceSchema = object(Object.fromEntries(['headline', 'summary', 'sections'].map(key => [key, { anyOf: [supportSchema, object({})] }])));
const roleSchema = object({ id: uuid, employer: text(300), title: text(300), startDate: text(40), endDate: text(40), location: text(300), sourceRefs: array(sourceRefSchema, 50), factIds: { ...array(uuid, 50), uniqueItems: true } }, ['id', 'employer', 'title', 'startDate', 'endDate', 'sourceRefs']);
const facetSchema = object({ status: { enum: ['unreviewed', 'answered', 'declined', 'unknown'] }, support: supportSchema }, ['status']);
const roleReviewSchema = object({ roleId: uuid, ...Object.fromEntries(CV_REVIEW_FACETS.map(facet => [facet, facetSchema])) });
const sourceSetSchema = array(object({ sourceId: uuid, contentHash: digest }), 1000);
const MAX_MASTER_VERSION = Number.MAX_SAFE_INTEGER - 1;
const reviewSaveSchema = object({ ...mutationSchema, sourceSetFingerprint: digest, reviewedSourceIds: { ...array(uuid, 1000), uniqueItems: true }, roles: array(roleSchema, 100), review: array(roleReviewSchema, 100), complete: { type: 'boolean' } });
const masterSaveSchema = object({ ...mutationSchema, baseVersion: { type: 'integer', minimum: 0 }, sourceSetFingerprint: digest, document: cvDocumentSchema, presentation: presentationSchema, evidence: documentEvidenceSchema });
const requiredContactKeys = ['name', 'email', 'phone', 'location', 'linkedinUrl', 'links'];
const contactKeys = [...requiredContactKeys, 'country', 'addressLine1', 'addressLine2', 'city', 'postalCode'];
const manualDocumentSchema = structuredClone(cvDocumentSchema);
function loosen(schema) {
  if (!schema || typeof schema !== 'object') return;
  if (schema.type === 'string' && !schema.format && !schema.pattern?.startsWith('^[a-f')) { schema.minLength = 0; delete schema.pattern; }
  if (schema === manualDocumentSchema.properties.highlights?.items?.properties?.support) return;
  for (const value of Object.values(schema)) if (value && typeof value === 'object') {
    if (Array.isArray(value)) value.forEach(loosen); else loosen(value);
  }
}
loosen(manualDocumentSchema);
manualDocumentSchema.properties.highlights.items.properties.support = object({}, []);
manualDocumentSchema.properties.highlights.items.properties.support.additionalProperties = true;
manualDocumentSchema.properties.experience.items.properties.bullets.items.properties.support = manualDocumentSchema.properties.highlights.items.properties.support;
for (const key of ['employer', 'role', 'startDate', 'endDate']) manualDocumentSchema.properties.experience.items.properties[key] = cvDocumentSchema.properties.experience.items.properties[key];
manualDocumentSchema.properties.highlights.items.properties.text = claimSchema.properties.text;
const contactSchema = object(Object.fromEntries(contactKeys.map(key => [key, key === 'links' ? profileFields.links : { anyOf: [{ type: 'string', maxLength: profileFields[key].anyOf[0].maxLength }, { type: 'null' }] }])), requiredContactKeys);
const manualSaveSchema = object({ ...mutationSchema, baseVersion: { type: 'integer', minimum: 0 }, contact: contactSchema, document: manualDocumentSchema, presentation: presentationSchema });
export const masterExportSchema = object({ ...mutationSchema, baseVersion: { type: 'integer', minimum: 1 }, format: { enum: ['pdf', 'txt'] } });
const ajv = new Ajv({ strict: false, allErrors: false });
addFormats(ajv);
const validators = new Map();
function valid(schema, value) {
  if (!validators.has(schema)) validators.set(schema, ajv.compile(schema));
  return validators.get(schema)(value);
}
function validate(schema, value, label) {
  if (!valid(schema, value)) fail('INVALID_INPUT', `${label}: provide valid fields using the advertised schema. ${validators.get(schema).errors?.[0]?.instancePath || ''}`);
}
const now = () => new Date().toISOString();
const defaultPresentation = Object.freeze({ template: 'classic', paper: 'A4' });
const resolveIdentity = identity => typeof identity === 'function' ? identity() : identity;
const allRoles = career => Object.values(career.roles ?? {});
const activeSources = career => Object.values(career.sources ?? {}).filter(source => !source.archived && source.purpose === 'cv');
const contact = career => Object.fromEntries(contactKeys.map(key => [key, career.profile?.[key] ?? (key === 'links' ? [] : null)]));
const factMaterial = fact => ({ id: fact.id, kind: fact.kind, subject: fact.subject, answer: fact.answer, detail: fact.detail, employer: fact.employer, roleId: fact.roleId, facet: fact.facet, resolution: fact.resolution, resolutionOrigin: fact.resolutionOrigin, publication: fact.publication, publicationOrigin: fact.publicationOrigin, publicationRestrictions: fact.publicationRestrictions });
export const sourceSet = career => Object.entries(career.sources ?? {}).filter(([, source]) => !source.archived && source.purpose === 'cv').map(([sourceId, source]) => ({ sourceId, contentHash: hash(source.text ?? '') })).sort((a, b) => a.sourceId.localeCompare(b.sourceId));
export const sourceSetFingerprint = career => hash(sourceSet(career));
const roleFingerprint = role => hash(role);
const supportFingerprint = (career, support = {}) => hash({ sources: support.sources ?? [], facts: (support.facts ?? []).map(id => career.facts?.[id] ? factMaterial(career.facts[id]) : { id, missing: true }) });
const reviewFingerprint = career => hash({ sourceSet: career.cvReview?.sourceSet, reviewedSourceIds: career.cvReview?.reviewedSourceIds, roles: career.cvReview?.roles });
export function masterEvidenceFingerprint(career) {
  const { preferences: _preferences, onboarding: _onboarding, ...profile } = career.profile ?? {};
  return hash({ sources: sourceSet(career), roles: allRoles(career).sort((a, b) => a.id.localeCompare(b.id)), facts: Object.entries(career.facts ?? {}).map(([id, fact]) => factMaterial({ ...fact, id })).sort((a, b) => a.id.localeCompare(b.id)), profile, careerGap: careerGapBinding(career) });
}
export const MASTER_CV_POLICY_ID = hash({ guide: CV_WRITING_GUIDE, schema: cvDocumentSchema, evidence: documentEvidenceSchema });
const documentClaims = document => [...(document?.highlights ?? []).map(claim => ({ ...claim })), ...(document?.experience ?? []).flatMap(role => role.bullets.map(claim => ({ ...claim, roleId: role.roleId })))];
function textLeaves(value) {
  if (typeof value === 'string') return value.trim() ? [value] : [];
  return value && typeof value === 'object' ? Object.values(value).flatMap(textLeaves) : [];
}
/** User edits are authoritative changes, while removals are publication omissions, not assertions that an event never occurred. */
export function masterEditConstraints(career) {
  const versions = [...(career.masterCv?.history ?? []), ...(career.masterCv?.current ? [career.masterCv.current] : [])], claims = {}, sections = {};
  let previous;
  for (const version of versions) {
    if (version.editedBy === 'user') {
      const before = new Map(documentClaims(previous?.document).map(claim => [claim.id, claim])), after = new Map(documentClaims(version.document).map(claim => [claim.id, claim]));
      for (const id of new Set([...before.keys(), ...after.keys()])) {
        const old = before.get(id), current = after.get(id);
        if (old?.text === current?.text && old?.roleId === current?.roleId) continue;
        const prior = claims[id];
        claims[id] = { id, roleId: current?.roleId ?? old?.roleId, removed: !current, text: current?.text ?? old?.text, support: current?.support ?? {},
          previousTexts: [...new Set([...(prior?.previousTexts ?? []), ...(old ? [old.text] : [])])],
          supersededSupport: [...(prior?.supersededSupport ?? []), ...(old ? [old.support] : [])] };
      }
      for (const field of ['headline', 'summary', 'sections']) {
        const content = document => field === 'sections' ? Object.fromEntries(['skills', 'education', 'languages', 'certifications', 'additional'].map(key => [key, document?.[key] ?? []])) : document?.[field] ?? '';
        if (hash(content(previous?.document)) !== hash(content(version.document))) sections[field] = {
          text: field === 'sections' ? JSON.stringify(content(version.document)) : content(version.document), support: version.evidence?.[field] ?? {},
          currentTexts: textLeaves(content(version.document)),
          previousTexts: [...new Set([...(sections[field]?.previousTexts ?? []), ...textLeaves(content(previous?.document))])],
          supersededSupport: [...(sections[field]?.supersededSupport ?? []), ...(previous?.evidence?.[field] ? [previous.evidence[field]] : [])] };
      }
    }
    previous = version;
  }
  const currentClaims = documentClaims(career.masterCv?.current?.document);
  for (const [id, constraint] of Object.entries(claims)) if (constraint.removed && currentClaims.some(claim => claim.id !== id && claim.text === constraint.text &&
    claim.roleId === constraint.roleId && claims[claim.id] && !claims[claim.id].removed)) delete claims[id];
  return { claims, sections };
}
const overlaps = (a, b) => a.sourceId === b.sourceId && a.contentHash === b.contentHash && (a.quote.includes(b.quote) || b.quote.includes(a.quote));
const savedRoleIdentities = (career, role) => [role, ...[...(career.masterCv?.history ?? []), ...(career.masterCv?.current ? [career.masterCv.current] : [])]
  .flatMap(version => version.document.experience.filter(entry => entry.roleId === role.id))];
export function assertPublishableText(career, value, field = 'document') {
  const texts = typeof value === 'string' ? [value] : Array.isArray(value) ? value : [];
  for (const fact of Object.values(career.facts ?? {}).filter(item => item.publication === 'prohibited')) {
    const restricted = [...(fact.publicationRestrictions?.texts ?? []), ...(fact.publicationRestrictions?.sources ?? []).map(ref => ref.quote)];
    if (!restricted.length) restricted.push(fact.answer ?? '', fact.detail ?? '');
    // Role identities are structured evidence: a private compound identity must
    // not be exposed one employer/location field at a time outside Experience. Do not
    // turn generic job titles or years into global forbidden words.
    const role = career.roles?.[fact.roleId];
    if (role && (fact.facet === 'role_identity' || role.factIds?.includes(fact.id))) {
      const literal = [fact.answer ?? '', fact.detail ?? '', ...restricted].join('\n');
      for (const identity of savedRoleIdentities(career, role)) for (const name of [identity.employer, identity.location])
        if (name?.trim() && literal.includes(name)) restricted.push(name);
    }
    for (const role of allRoles(career)) for (const ref of fact.publicationRestrictions?.sources ?? []) {
      if (!role.sourceRefs.some(binding => overlaps(binding, ref))) continue;
      for (const identity of savedRoleIdentities(career, role)) if (ref.quote.includes(identity.employer) && ref.quote.includes(identity.title ?? identity.role)) {
        restricted.push(identity.employer);
        if (identity.location?.trim() && ref.quote.includes(identity.location)) restricted.push(identity.location);
      }
    }
    if (restricted.some(secret => secret.trim() && texts.some(text => text.includes(secret))))
      fail('PUBLICATION_RESTRICTED', `${field} contains information the candidate asked not to publish. Omit it or ask for publication-safe wording; do not rephrase confidential details to bypass their restriction.`);
  }
}
function assertCurrentUserEvidence(career, support, { roleId, claim, claimId, field }) {
  const constraints = masterEditConstraints(career), rule = constraints.claims[claimId], current = career.masterCv?.current;
  const unchanged = claim !== undefined && (claimId
    ? documentClaims(current?.document).some(item => item.id === claimId && item.text === claim && item.roleId === roleId && hash(item.support) === hash(support))
    : ['headline', 'summary'].includes(field) && current?.document?.[field] === claim && hash(current.evidence?.[field]) === hash(support));
  if (unchanged && !rule?.removed) return;
  if (rule && (rule.removed || claim !== rule.text)) fail('USER_EDIT_CONFLICT', 'Keep this user-edited claim exactly as saved, or omit it. A removed claim cannot be restored by tailoring.');
  for (const item of Object.values(constraints.claims)) if (claim && (!roleId || !item.roleId || roleId === item.roleId) && ((item.removed && claim === item.text) || (claim !== item.text && item.previousTexts.includes(claim))))
    fail('USER_EDIT_CONFLICT', 'This wording was removed or replaced by the candidate. Use their current wording and facts, not older original-CV claims.');
  // Editing a bio does not retract every original CV passage that supported it.
  // Section ownership applies to that section; claim ownership remains role-bound.
  const section = ['headline', 'summary'].includes(field) ? field
    : /^(sections|skills\[|education\[|languages\[|certifications\[|additional\[)/.test(field ?? '') ? 'sections' : null;
  const sectionRule = section && constraints.sections[section];
  if (sectionRule && claim && sectionRule.previousTexts.includes(claim) && !sectionRule.currentTexts.includes(claim))
    fail('USER_EDIT_CONFLICT', 'This section wording was replaced by the candidate. Preserve their current wording and qualifications when tailoring.');
  const qualifiedSection = sectionRule && (support.facts ?? []).some(id => (sectionRule.support.facts ?? []).includes(id));
  for (const item of [...Object.values(constraints.claims), ...(sectionRule ? [sectionRule] : [])]) {
    if (roleId && item.roleId && item.roleId !== roleId) continue;
    for (const superseded of item.supersededSupport) {
      if ((!(item === sectionRule && qualifiedSection) && (support.sources ?? []).some(ref => (superseded.sources ?? []).some(prior => overlaps(ref, prior)))) ||
          (support.facts ?? []).some(id => (superseded.facts ?? []).includes(id) && !(item.support.facts ?? []).includes(id)))
        fail('USER_EDIT_CONFLICT', 'This evidence was superseded by the candidate’s manual edit. Cite the current user-stated fact and preserve its qualifications instead of reviving an earlier claim.');
    }
  }
}
function assertRolePublication(career, role) {
  const facts = Object.values(career.facts ?? {}).filter(fact => fact.roleId === role.id && (fact.facet === 'role_identity' || role.factIds?.includes(fact.id)));
  const identity = [role.employer, role.title, role.startDate, role.endDate, role.location].filter(Boolean);
  const permitted = facts.some(fact => fact.publication === 'allowed' && fact.publicationOrigin && identity.every(value => [fact.answer, fact.detail ?? ''].join('\n').includes(value)));
  if (permitted) return;
  if (facts.some(fact => fact.publication === 'prohibited'))
    fail('PUBLICATION_RESTRICTED', 'This role identity was marked private. Omit the role or record the candidate’s separate publication-safe employer/title/date wording before using its structured fields.');
  const restricted = Object.values(career.facts ?? {}).filter(fact => fact.publication === 'prohibited').flatMap(fact => fact.publicationRestrictions?.sources ?? []);
  if (role.sourceRefs.some(ref => restricted.some(secret => overlaps(ref, secret) && secret.quote.includes(role.employer) && secret.quote.includes(role.title))))
    fail('PUBLICATION_RESTRICTED', 'This original role identity was marked private. Use separately permitted identity wording, not fields copied out of that passage.');
}

export function assertSourceRef(career, ref, roleId) {
  validate(sourceRefSchema, ref, 'Source evidence');
  const source = career.sources?.[ref.sourceId];
  if (!source || source.archived || source.purpose !== 'cv' || hash(source.text ?? '') !== ref.contentHash || !source.text?.includes(ref.quote))
    fail('UNKNOWN_QUOTE', 'Quote the exact text of a current original CV with its current sourceId and contentHash. Read career_cv_review_read and career_source_read.');
  if (roleId && !career.roles?.[roleId]?.sourceRefs?.some(binding => binding.sourceId === ref.sourceId && binding.contentHash === ref.contentHash && binding.quote.includes(ref.quote)))
    fail('MISATTRIBUTED_FACT', 'This original-CV quote is outside the cited employment role. Reconcile the role source bindings rather than transferring another role’s achievement.');
  return ref.quote;
}
export function assertSupport(career, support, { roleId, text: claim, claimId, field = 'claim', forReview = false, preserveCurrent = false } = {}) {
  validate(supportSchema, support, `${field} support`);
  if (!forReview) {
    if (!preserveCurrent) assertCurrentUserEvidence(career, support, { roleId, claim, claimId, field });
    if (claim !== undefined) assertPublishableText(career, claim, field);
    for (const fact of Object.values(career.facts ?? {}).filter(item => item.publication === 'prohibited'))
      if ((support.sources ?? []).some(ref => (fact.publicationRestrictions?.sources ?? []).some(restricted => overlaps(ref, restricted))))
        fail('PUBLICATION_RESTRICTED', 'This original-CV passage was marked confidential. Use separately permitted wording instead.');
  }
  const texts = (support.sources ?? []).map(ref => assertSourceRef(career, ref, roleId));
  for (const id of support.facts ?? []) {
    const fact = career.facts?.[id];
    if (!fact) fail('UNKNOWN_FACT', `${field}: cite a currently saved fact.`);
    if (roleId && fact.roleId !== roleId) fail('MISATTRIBUTED_FACT', `${field}: the fact belongs to a different role or is global. Use evidence scoped to this exact roleId.`);
    if (!forReview && fact.publication === 'prohibited') fail('PUBLICATION_RESTRICTED', `${field}: this fact is private. Omit it or obtain a separate publication-safe answer.`);
    if (fact.resolution === 'declined' || fact.resolution === 'unknown') fail('UNSUPPORTED_REQUIREMENT', `${field}: a declined or unknown answer is not evidence of an achievement.`);
    if (!forReview && ((fact.kind === 'capability' && fact.answer === 'None') || (fact.kind === 'yes_no' && fact.answer === 'No')))
      fail('UNSUPPORTED_REQUIREMENT', `${field}: a known negative answer is not positive evidence of a capability or achievement.`);
    texts.push(fact.answer ?? '', fact.detail ?? '');
  }
  if (claim !== undefined) {
    const unsupported = unsupportedNumbers(claim, [...texts, ...texts.flatMap(value => value.match(/\b(?:19|20)\d{2}\b/g) ?? [])]);
    if (unsupported.length) fail('UNSUPPORTED_NUMBER', `${field}: ${unsupported.join(', ')} must occur in the evidence cited for this claim.`);
  }
  return texts;
}
function assertRole(career, role) {
  validate(roleSchema, role, 'Role');
  const texts = role.sourceRefs.map(ref => assertSourceRef(career, ref));
  for (const id of role.factIds ?? []) {
    const fact = career.facts?.[id];
    if (!fact || fact.roleId !== role.id) fail('MISATTRIBUTED_FACT', 'Role identity facts must exist and belong to this roleId.');
    texts.push(fact.answer ?? '', fact.detail ?? '');
  }
  if (!texts.length) fail('UNSUPPORTED_ROLE', 'Each role needs an original CV role binding or the candidate’s own saved role fact.');
  const corpus = texts.join('\n').toLocaleLowerCase();
  for (const [field, value] of [['employer', role.employer], ['title', role.title], ['startDate', role.startDate], ['endDate', role.endDate]]) {
    if (!corpus.includes(value.toLocaleLowerCase())) fail('UNSUPPORTED_ROLE', `The ${field} of this role is not in its own source or candidate-stated role evidence.`);
  }
}
function resolutionSupported(career, roleId, facet, state) {
  if (!state.support || state.support.sources?.length || !state.support.facts?.length) return false;
  return state.support.facts.every(id => {
    const fact = career.facts?.[id], origin = fact?.resolutionOrigin;
    const interview = origin?.kind === 'interview' ? career.interviews?.[origin.interviewId] : null;
    const responses = interview?.responses ?? [];
    const response = responses.find(item => item.id === origin?.responseId);
    const answer = response?.answers?.find(item => item.factId === fact?.id);
    return fact?.roleId === roleId && fact?.facet === facet && fact?.resolution === state.status &&
      answer?.question?.roleId === roleId && answer.question.facet === facet && answer.answer === fact.answer && answer.resolution === fact.resolution;
  });
}
function assertFacet(career, role, facet, state) {
  validate(facetSchema, { status: state.status, ...(state.support ? { support: state.support } : {}) }, `Review ${facet}`);
  if (state.status === 'unreviewed') return false;
  if (state.status === 'answered') {
    for (const id of state.support?.facts ?? []) {
      const fact = career.facts?.[id];
      if (role.factIds?.includes(id) || (fact?.facet && fact.facet !== facet)) fail('MISATTRIBUTED_FACT', `The ${facet} review must cite this role’s ${facet} facts, not a different facet or role identity answer.`);
    }
    const texts = assertSupport(career, state.support, { roleId: role.id, field: `${role.title} ${facet}`, forReview: true });
    if (!texts.some(value => value.trim() && !/^(?:unknown|skip|decline|declined|not known|i (?:do not|don't) know)[.!]?$/i.test(value.trim())))
      fail('REVIEW_RESPONSE_REQUIRED', 'An unresolved answer must be recorded as the candidate’s actual declined/unknown response, not relabelled answered.');
  }
  else if (!resolutionSupported(career, role.id, facet, state)) fail('REVIEW_RESPONSE_REQUIRED', 'A declined or unknown facet needs the candidate’s actual recorded interview response for this role and facet; agents cannot skip review.');
  return true;
}
function facetCurrent(career, role, facet, state) {
  if (!state || state.roleFingerprint !== roleFingerprint(role) || state.evidenceFingerprint !== supportFingerprint(career, state.support)) return false;
  try { return assertFacet(career, role, facet, state); } catch { return false; }
}
export function cvReviewState(career) {
  const roles = allRoles(career), current = sourceSetFingerprint(career), review = career.cvReview;
  const pendingRoles = roles.filter(role => CV_REVIEW_FACETS.some(facet => !facetCurrent(career, role, facet, review?.roles?.[role.id]?.[facet]))).length;
  const pendingQuestions = Object.values(career.interviews ?? {}).filter(item => item.status === 'pending' && item.target?.kind === 'cv_review' && item.target.sourceSetFingerprint === current).reduce((count, item) => count + (item.questions?.length ?? 0), 0);
  const complete = Boolean(review && review.completedSourceSetFingerprint === current && review.sourceSetFingerprint === current && !pendingRoles && !pendingQuestions && hash([...(review.reviewedSourceIds ?? [])].sort()) === hash(sourceSet(career).map(item => item.sourceId).sort()));
  return { complete, pendingRoles, pendingQuestions };
}
function assertUniqueDocument(document) {
  const roles = document.experience.map(entry => entry.roleId), claims = [...(document.highlights ?? []), ...document.experience.flatMap(entry => entry.bullets)];
  if (new Set(roles).size !== roles.length || new Set(claims.map(claim => claim.id)).size !== claims.length) fail('INVALID_INPUT', 'Each document roleId and claim id must occur only once.');
}
export function assertDocumentEvidence(career, document, evidence) {
  validate(cvDocumentSchema, document, 'CV document');
  validate(documentEvidenceSchema, evidence, 'Document evidence');
  assertUniqueDocument(document);
  const { careerGaps: _gaps, ...content } = document;
  const { careerGaps: _currentGaps, ...currentContent } = career.masterCv?.current?.document ?? {};
  const preserveCurrent = Boolean(career.masterCv?.current && hash(content) === hash(currentContent) && hash(evidence) === hash(career.masterCv.current.evidence));
  for (const item of cvDocumentTexts(renderableCv(document))) assertPublishableText(career, item.text, item.field);
  assertSupport(career, evidence.headline, { text: document.headline, field: 'headline', preserveCurrent });
  assertSupport(career, evidence.summary, { text: document.summary, field: 'summary', preserveCurrent });
  for (const claim of document.highlights ?? []) assertSupport(career, claim.support, { text: claim.text, claimId: claim.id, field: 'highlight', preserveCurrent });
  for (const entry of document.experience) {
    const role = career.roles?.[entry.roleId];
    if (!role) fail('UNSUPPORTED_ROLE', 'Use a canonical roleId returned by career_cv_review_read.');
    assertRolePublication(career, role);
    for (const [field, key] of [['employer', 'employer'], ['role', 'title'], ['startDate', 'startDate'], ['endDate', 'endDate'], ['location', 'location']]) {
      if ((entry[field] ?? '') !== (role[key] ?? '')) fail('UNSUPPORTED_ROLE', `Role ${field} must match the saved role identity. Reconcile evidence with career_cv_review_save first.`);
    }
    for (const claim of entry.bullets) assertSupport(career, claim.support, { roleId: entry.roleId, text: claim.text, claimId: claim.id, field: `${entry.role} achievement`, preserveCurrent });
  }
  // Role identities and derived break dates are validated against the canonical timeline, not optional-section evidence.
  const sections = cvDocumentTexts(renderableCv(document)).filter(item => !item.claim && !item.setting && !/^(headline|summary|experience\[|careerGaps\[)/.test(item.field));
  assertSupport(career, evidence.sections, { field: 'sections', preserveCurrent });
  for (const item of sections) assertSupport(career, evidence.sections, { text: item.text, field: item.field, preserveCurrent });
  if (hash(document.careerGaps ?? []) !== hash(masterCareerGaps(career, document) ?? [])) fail('CAREER_GAP_CHANGED', 'Career gaps use the saved setting and evidenced dates. Read the current master and preserve its generated gap entries.');
}

function datePoint(value) {
  if (/^\d{4}(?:-(?:0[1-9]|1[0-2]))?$/.test(value)) return value;
  if (/^(present|current|now)$/i.test(value)) return 'present';
  const match = /^(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+(\d{4})$/i.exec(value);
  if (!match) return null;
  const month = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'].indexOf(match[1].slice(0, 3).toLowerCase()) + 1;
  return `${match[2]}-${String(month).padStart(2, '0')}`;
}
export function masterCareerGaps(career) {
  if (!savedCareerGap(career).enabled) return undefined;
  const roles = allRoles(career).map(role => ({ start: datePoint(role.startDate), end: datePoint(role.endDate) }));
  if (!roles.length || roles.some(role => !role.start || !role.end || role.start === 'present')) return undefined;
  roles.sort((a, b) => a.start.localeCompare(b.start));
  const gaps = [];
  let end = roles[0].end;
  for (const role of roles.slice(1)) {
    if (end !== 'present' && role.start > end) {
      try { gaps.push(...resolveCareerGaps(career, [{ start: end, end: role.start }])); }
      catch (error) { if (!['CAREER_GAP_TOO_SHORT', 'CAREER_GAP_OUT_OF_RANGE'].includes(error.code)) throw error; }
    }
    if (end !== 'present' && (role.end === 'present' || role.end > end)) end = role.end;
  }
  if (end !== 'present') {
    try { gaps.push(...resolveCareerGaps(career, [{ start: end, end: 'present' }])); }
    catch (error) { if (!['CAREER_GAP_TOO_SHORT', 'CAREER_GAP_OUT_OF_RANGE'].includes(error.code)) throw error; }
  }
  return gaps.length ? gaps.reverse().slice(0, 5) : undefined;
}
function withGaps(career, document) {
  const { careerGaps: _ignored, ...authored } = structuredClone(document), gaps = masterCareerGaps(career, authored);
  return { ...authored, ...(gaps ? { careerGaps: gaps } : {}) };
}
function currentStatus(career) {
  const master = career.masterCv?.current;
  if (!master) return 'missing';
  if (master.policyId !== MASTER_CV_POLICY_ID || master.sourceSetFingerprint !== sourceSetFingerprint(career) || master.evidenceFingerprint !== masterEvidenceFingerprint(career) || master.reviewFingerprint !== reviewFingerprint(career)) return 'stale';
  if (!cvReviewState(career).complete) return 'draft';
  try { assertDocumentEvidence(career, master.document, master.evidence); } catch { return 'draft'; }
  return 'ready';
}
export function masterCvState(career, identity = '') {
  const current = career.masterCv?.current;
  return { revision: career.revision, identity: resolveIdentity(identity), master: current ? { version: current.version, updatedAt: current.updatedAt, document: structuredClone(current.document), presentation: structuredClone(current.presentation) } : null,
    contact: contact(career), sourceSetFingerprint: sourceSetFingerprint(career), status: currentStatus(career), review: cvReviewState(career), userEdited: Boolean(current?.userEdited) };
}
export function assertMasterReady(career) {
  if (currentStatus(career) !== 'ready') fail('MASTER_NOT_READY', 'Complete the current full-source outcomes review with career_cv_review_read/save, then save or reconcile the Master CV. Tailoring and export need a ready current master; existing drafts are preserved.');
  return career.masterCv.current;
}
function assertVersion(career, version) {
  if ((career.masterCv?.current?.version ?? 0) !== version) fail('VERSION_CONFLICT', 'The Master CV changed. Read the latest version and merge your edits; the saved document was not replaced.');
}
function storeMaster(career, { document, presentation, evidence, editedBy }) {
  const previous = career.masterCv?.current, timestamp = now();
  if ((previous?.version ?? 0) >= MAX_MASTER_VERSION) fail('VERSION_CONFLICT', 'The Master CV version limit was reached. Saved work is preserved; contact support before creating another version.');
  career.masterCv ??= { current: null, history: [] };
  if (previous) career.masterCv.history.push(structuredClone(previous));
  career.masterCv.current = { version: (previous?.version ?? 0) + 1, document: structuredClone(document), presentation: structuredClone(presentation), evidence: structuredClone(evidence),
    sourceSetFingerprint: sourceSetFingerprint(career), evidenceFingerprint: masterEvidenceFingerprint(career), reviewFingerprint: reviewFingerprint(career), policyId: MASTER_CV_POLICY_ID,
    editedBy, userEdited: editedBy === 'user' || Boolean(previous?.userEdited), createdAt: timestamp, updatedAt: timestamp };
  career.evidenceRevision = (career.evidenceRevision ?? 0) + 1;
}
function readReview(career) {
  const current = sourceSet(career), previous = career.cvReview?.sourceSet ?? [], old = new Map(previous.map(source => [source.sourceId, source.contentHash])), fresh = new Map(current.map(source => [source.sourceId, source.contentHash]));
  return { revision: career.revision, sourceSet: current, sourceSetFingerprint: hash(current), completedSourceSetFingerprint: career.cvReview?.completedSourceSetFingerprint ?? null,
    sourceChanges: { added: current.filter(item => !old.has(item.sourceId)), removed: previous.filter(item => !fresh.has(item.sourceId)), changed: current.filter(item => old.has(item.sourceId) && old.get(item.sourceId) !== item.contentHash) },
    sources: activeSources(career).map(source => ({ id: source.id, name: source.name, contentHash: hash(source.text ?? ''), characters: (source.text ?? '').length })), roles: structuredClone(allRoles(career)),
    review: allRoles(career).map(role => ({ roleId: role.id, ...Object.fromEntries(CV_REVIEW_FACETS.map(facet => {
      const saved = career.cvReview?.roles?.[role.id]?.[facet];
      return [facet, saved && facetCurrent(career, role, facet, saved) ? { status: saved.status, ...(saved.support ? { support: structuredClone(saved.support) } : {}) } : { status: 'unreviewed' }];
    })) })), facts: structuredClone(Object.values(career.facts ?? {})), pendingInterviews: structuredClone(Object.values(career.interviews ?? {}).filter(interview => interview.status === 'pending')), masterVersion: career.masterCv?.current?.version ?? 0, ...cvReviewState(career) };
}
function assertReviewedSources(career, args) {
  if (args.sourceSetFingerprint !== sourceSetFingerprint(career)) fail('SOURCE_SET_CHANGED', 'The active original CV set changed. Read every new or changed source and reconcile the full checkpoint again.');
  if (hash([...args.reviewedSourceIds].sort()) !== hash(sourceSet(career).map(item => item.sourceId).sort())) fail('SOURCE_REVIEW_INCOMPLETE', 'reviewedSourceIds must name every active original CV, including sources with no employment roles. Read every full original before completing review.');
}
export function createMasterCvTools({ store, identity = '' }) {
  return [
    { name: 'career_cv_review_read', description: 'Read the full active-original source checkpoint, stable employment roles, durable facts and unresolved outcomes/growth/complex-scenario review. Read every original source in full, reuse supported facts, and ask only missing role-specific narrative questions.', inputSchema: object({}), readOnly: true, invoke: () => readReview(readCareer(store)) },
    { name: 'career_cv_review_save', description: 'Reconcile every active original CV and stable role identity. reviewedSourceIds covers all originals even without roles. Save an incomplete checkpoint before interviewing; complete only when every role facet has evidence or an actual recorded user decline/unknown. Never fabricate progression or outcomes.', inputSchema: reviewSaveSchema, readOnly: false, invoke: args => {
      validate(reviewSaveSchema, args, 'CV review');
      return mutateCareer(store, args, 'career_cv_review_save', args, career => {
        assertReviewedSources(career, args);
        const roleIds = args.roles.map(role => role.id), reviewIds = args.review.map(row => row.roleId);
        if (new Set(roleIds).size !== roleIds.length || new Set(reviewIds).size !== reviewIds.length || hash([...roleIds].sort()) !== hash([...reviewIds].sort())) fail('INVALID_INPUT', 'Provide each stable role once and exactly one review row for each role.');
        for (const prior of allRoles(career)) if (!roleIds.includes(prior.id)) {
          const independent = Object.values(career.facts ?? {}).some(fact => fact.roleId === prior.id);
          const active = prior.sourceRefs.some(ref => sourceSet(career).some(source => source.sourceId === ref.sourceId && source.contentHash === ref.contentHash));
          if (independent || active) fail('ROLE_OMITTED', 'Keep existing role identities that still have active sources or independent candidate facts. Do not merge roles because the employer is the same.');
        }
        const identities = args.roles.map(role => hash([role.employer.toLocaleLowerCase(), role.title.toLocaleLowerCase(), role.startDate, role.endDate]));
        if (new Set(identities).size !== identities.length) fail('INVALID_INPUT', 'Reuse the existing roleId for the same employment episode rather than duplicating it.');
        for (let i = 0; i < args.roles.length; i++) for (const other of args.roles.slice(i + 1)) {
          const role = args.roles[i];
          for (const ref of role.sourceRefs) for (const candidate of other.sourceRefs) {
            const sharedHeading = [role.employer, role.title, role.location].filter(Boolean).some(value => ref.quote.trim() === value && candidate.quote.trim() === value);
            if (!sharedHeading && overlaps(ref, candidate)) fail('MISATTRIBUTED_FACT', 'Different employment roles need separate role-local source excerpts, not the same whole-CV passage. Keep shared employer headings separate from each role’s dates and achievements.');
          }
        }
        const previousRoles = hash(career.roles ?? {});
        career.roles = Object.fromEntries(args.roles.map(role => [role.id, structuredClone(role)]));
        const assignedFacts = new Set();
        for (const role of args.roles) for (const id of role.factIds ?? []) {
          const fact = career.facts?.[id];
          if (!fact || assignedFacts.has(id) || (fact.roleId && fact.roleId !== role.id)) fail('MISATTRIBUTED_FACT', 'A role identity fact must belong to exactly one employment episode.');
          assignedFacts.add(id);
          if (!fact.roleId) {
            const literal = [fact.answer, fact.detail ?? ''].join('\n').toLocaleLowerCase();
            if (![role.employer, role.title, role.startDate, role.endDate].every(value => literal.includes(value.toLocaleLowerCase()))) fail('UNSUPPORTED_ROLE', 'To reconcile a global fact to a role, its literal answer must identify that employer, title and dates. Ask for the missing role identity first.');
            fact.roleId = role.id;
          }
        }
        for (const role of args.roles) {
          const provisional = !role.sourceRefs.length && !(role.factIds ?? []).length && !args.complete;
          if (provisional && CV_REVIEW_FACETS.some(facet => args.review.find(row => row.roleId === role.id)[facet].status !== 'unreviewed'))
            fail('UNSUPPORTED_ROLE', 'A provisional role needs identity clarification before its outcome facets can be resolved.');
          if (!provisional) assertRole(career, role);
        }
        const timestamp = now(), reviews = {};
        for (const row of args.review) {
          const role = career.roles[row.roleId];
          reviews[row.roleId] = { roleId: row.roleId };
          for (const facet of CV_REVIEW_FACETS) {
            const state = row[facet], resolved = assertFacet(career, role, facet, state);
            if (args.complete && !resolved) fail('REVIEW_INCOMPLETE', 'Resolve outcomes, growth and a complex assignment for every role with existing evidence or the candidate’s actual response before completing.');
            reviews[row.roleId][facet] = { ...structuredClone(state), roleFingerprint: roleFingerprint(role), evidenceFingerprint: supportFingerprint(career, state.support), updatedAt: timestamp };
          }
        }
        if (args.complete && !activeSources(career).length && !Object.keys(career.facts ?? {}).length) fail('REVIEW_INCOMPLETE', 'Import an original CV or record the candidate’s actual background before completing an empty review.');
        if (args.complete && Object.values(career.interviews ?? {}).some(item => item.status === 'pending' && item.target?.kind === 'cv_review' && item.target.sourceSetFingerprint === args.sourceSetFingerprint)) fail('REVIEW_INCOMPLETE', 'Finish or cancel the pending review questions before completing the checkpoint.');
        career.cvReview = { sourceSet: sourceSet(career), sourceSetFingerprint: args.sourceSetFingerprint, reviewedSourceIds: [...args.reviewedSourceIds].sort(), completedSourceSetFingerprint: args.complete ? args.sourceSetFingerprint : null, roles: reviews, updatedAt: timestamp };
        if (hash(career.roles) !== previousRoles) career.evidenceRevision = (career.evidenceRevision ?? 0) + 1;
        return readReview(career);
      });
    } },
    { name: 'career_master_cv_read', description: 'Read the saved editable Master CV, readiness, current review evidence and complete drafting guidance. Stale/user-edited documents remain readable. Never use master wording as independent evidence.', inputSchema: object({}), readOnly: true, invoke: () => {
      const career = readCareer(store);
      return { ...masterCvState(career, identity), guide: CV_WRITING_GUIDE, evidence: structuredClone(career.masterCv?.current?.evidence ?? null), roles: structuredClone(allRoles(career)), facts: structuredClone(Object.values(career.facts ?? {})), sourceSet: sourceSet(career), policyId: MASTER_CV_POLICY_ID };
    } },
    { name: 'career_master_cv_save', description: 'Save a version-bound master after the complete current outcomes review. Every claim cites role-scoped original/fact evidence. evidence supports headline, summary and other sections. User-owned wording cannot be silently replaced: present exact proposed edits for the candidate to apply in Companion, then reread. Identical authored content may be rebound to current valid evidence.', inputSchema: masterSaveSchema, readOnly: false, invoke: args => {
      validate(masterSaveSchema, args, 'Master CV');
      return mutateCareer(store, args, 'career_master_cv_save', args, career => {
        assertVersion(career, args.baseVersion);
        if (args.sourceSetFingerprint !== sourceSetFingerprint(career)) fail('SOURCE_SET_CHANGED', 'The originals changed. Read and complete the full current CV review before saving a master.');
        if (!cvReviewState(career).complete) fail('REVIEW_INCOMPLETE', 'Complete the full current source-set review first; reuse known facts and ask only unresolved role facets.');
        const document = withGaps(career, args.document), previous = career.masterCv?.current;
        if (previous?.userEdited && (hash(authoredDocument(previous.document)) !== hash(authoredDocument(document)) || hash(previous.presentation) !== hash(args.presentation))) fail('USER_EDIT_CONFLICT', 'This master contains user-owned edits and presentation. Do not replace them. Read career_master_cv_read, present exact proposed content or layout changes alongside the saved version, and have the candidate apply their choices in Companion → Me → Master CV. Then reread and reconcile unchanged authored content and presentation.');
        assertDocumentEvidence(career, document, args.evidence);
        storeMaster(career, { document, presentation: args.presentation, evidence: args.evidence, editedBy: 'agent' });
        return masterCvState(career, identity);
      });
    } },
  ];
}
function authoredDocument(document) {
  const result = structuredClone(document);
  // Breaks are derived from the user's separate setting, not editable master prose.
  delete result.careerGaps;
  for (const claim of [...(result.highlights ?? []), ...result.experience.flatMap(entry => entry.bullets)]) delete claim.support;
  return result;
}
function userFact(career, { id, subject, answer, roleId, facet }) {
  const previous = id ? career.facts[id] : Object.values(career.facts).find(fact => fact.origin === 'master_editor' && fact.subject === subject && fact.roleId === roleId);
  const factId = previous?.id ?? id ?? randomUUID(), timestamp = now();
  const publication = previous ? Object.fromEntries(['publication', 'publicationOrigin', 'publicationRestrictions'].filter(key => previous[key] !== undefined).map(key => [key, structuredClone(previous[key])])) : {};
  career.facts[factId] = { id: factId, kind: 'narrative', subject, answer, ...publication, ...(roleId ? { roleId } : {}), ...(facet ? { facet } : {}), question: 'What did you enter in the Master CV editor?', context: 'Candidate-authored Master CV edit', origin: 'master_editor', createdAt: previous?.createdAt ?? timestamp, updatedAt: timestamp };
  return { facts: [factId] };
}
export async function saveManualMaster({ store, args, identity = '' }) {
  validate(manualSaveSchema, args, 'Master CV editor');
  return mutateCareer(store, args, 'master-cv-save', args, career => {
    assertVersion(career, args.baseVersion);
    assertUniqueDocument(args.document);
    const previous = career.masterCv?.current, previousClaims = new Map([...(previous?.document.highlights ?? []), ...(previous?.document.experience ?? []).flatMap(entry => entry.bullets)].map(claim => [claim.id, claim]));
    const patch = Object.fromEntries(contactKeys.filter(key => Object.hasOwn(args.contact, key)).map(key => [key, key === 'links' ? args.contact.links.map(link => link.trim()).filter(Boolean) : args.contact[key]?.trim() || null]));
    patchProfile(career, patch);
    const document = structuredClone(args.document);
    career.roles ??= {};
    for (const entry of document.experience) {
      const current = career.roles[entry.roleId], fields = { id: entry.roleId, employer: entry.employer, title: entry.role, startDate: entry.startDate, endDate: entry.endDate, ...(entry.location ? { location: entry.location } : {}) };
      const heading = `${entry.employer} | ${entry.role} | ${entry.startDate} – ${entry.endDate}${entry.location ? ` | ${entry.location}` : ''}`;
      if (!current || ['employer', 'title', 'startDate', 'endDate', 'location'].some(key => (current[key] ?? '') !== (fields[key] ?? ''))) {
        const proof = userFact(career, { subject: `Role identity ${entry.roleId}`, answer: heading, roleId: entry.roleId, facet: 'role_identity' });
        career.roles[entry.roleId] = { ...fields, sourceRefs: current?.sourceRefs ?? [], factIds: [...new Set([...(current?.factIds ?? []), ...proof.facts])] };
      }
      for (const claim of entry.bullets) {
        const old = previousClaims.get(claim.id), oldRole = previous?.document.experience.find(role => role.bullets.some(item => item.id === claim.id));
        claim.support = old && old.text === claim.text && oldRole?.roleId === entry.roleId ? structuredClone(old.support) : userFact(career, { subject: `Master achievement ${claim.id}`, answer: claim.text, roleId: entry.roleId, facet: 'outcomes' });
      }
    }
    for (const claim of document.highlights ?? []) {
      const old = previousClaims.get(claim.id);
      claim.support = old && old.text === claim.text ? structuredClone(old.support) : userFact(career, { subject: `Master highlight ${claim.id}`, answer: claim.text });
    }
    const evidence = {};
    for (const key of ['headline', 'summary', 'sections']) {
      const sectionValue = value => key === 'sections' ? Object.fromEntries(['skills', 'education', 'languages', 'certifications', 'additional'].map(field => [field, value?.[field] ?? []])) : value?.[key] ?? '';
      const value = sectionValue(document);
      const empty = typeof value === 'string' ? !value.trim() : Object.values(value).every(items => !items.length);
      evidence[key] = empty ? (key === 'sections' ? structuredClone(evidence.summary?.facts || evidence.summary?.sources ? evidence.summary : evidence.headline) : {})
        : previous && hash(sectionValue(previous.document)) === hash(value) ? structuredClone(previous.evidence[key])
          : userFact(career, { subject: `Master CV ${key}`, answer: typeof value === 'string' ? value : JSON.stringify(value) });
    }
    storeMaster(career, { document: withGaps(career, document), presentation: args.presentation, evidence, editedBy: 'user' });
    return masterCvState(career, identity);
  });
}
export function masterExportSnapshot(career, args) {
  validate(masterExportSchema, args, 'Master export');
  if (career.revision !== args.revision) fail('REVISION_CONFLICT', 'The career record changed. Read the current Master CV before exporting.');
  assertVersion(career, args.baseVersion);
  const master = assertMasterReady(career);
  assertPublishableText(career, Object.values(masterHeading(career.profile)), 'CV contact');
  return structuredClone({ version: master.version, revision: career.revision, sourceSetFingerprint: sourceSetFingerprint(career), evidenceFingerprint: masterEvidenceFingerprint(career), document: master.document, presentation: master.presentation, contact: career.profile });
}
export function masterHeading(profile) {
  const values = [profile.email, profile.phone, profile.location, profile.addressLine1, profile.addressLine2, profile.city, profile.postalCode, profile.country, profile.linkedinUrl, ...(profile.links ?? [])].filter(value => typeof value === 'string' && value.trim()).map(value => value.trim());
  const name = profile.name || [profile.firstName, profile.lastName].filter(Boolean).join(' ') || profile.preferredName;
  return { ...(name?.trim() ? { name: name.trim() } : {}), ...(values.length ? { contact: [...new Set(values)].join(' · ') } : {}) };
}
export async function renderMaster(master, profile, documents, format) {
  if (!['pdf', 'txt'].includes(format)) fail('INVALID_INPUT', 'Choose PDF or TXT export.');
  const input = { document: renderableCv(master.document), heading: masterHeading(profile), presentation: master.presentation ?? defaultPresentation };
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

/** Backup validation is structural: stale/deleted original references in saved history remain historical evidence, not current readiness. */
function validateHistoricalSupport(career, support, roleId) {
  validate(supportSchema, support, 'Saved evidence');
  for (const ref of support.sources ?? []) {
    const source = career.sources?.[ref.sourceId];
    if (source && (source.purpose !== 'cv' || (hash(source.text ?? '') === ref.contentHash && !source.text?.includes(ref.quote))))
      fail('INVALID_INPUT', 'Saved evidence does not quote the identified original CV.');
  }
  for (const id of support.facts ?? []) if (roleId && career.facts?.[id] && career.facts[id].roleId !== roleId)
    fail('INVALID_INPUT', 'Saved evidence cites a fact belonging to another role.');
}
export function validateMasterCareer(career) {
  for (const fact of Object.values(career.facts ?? {})) {
    if (fact.roleId && !career.roles?.[fact.roleId]) fail('INVALID_INPUT', 'A role-scoped fact names an unknown role.');
    if (fact.resolutionOrigin && !resolutionSupported(career, fact.roleId, fact.facet, { status: fact.resolution, support: { facts: [fact.id] } }))
      fail('INVALID_INPUT', 'A recorded interview fact does not match its original answer.');
    if (['declined', 'unknown'].includes(fact.resolution) && !fact.resolutionOrigin) fail('INVALID_INPUT', 'A declined or unknown fact needs its recorded user response.');
    if (fact.publication !== undefined && !['allowed', 'prohibited'].includes(fact.publication)) fail('INVALID_INPUT', 'Invalid publication permission.');
    if (fact.publicationRestrictions) {
      validate(object({ texts: array(text(20000), 50), sources: array(sourceRefSchema, 30) }), fact.publicationRestrictions, 'Publication restrictions');
      for (const ref of fact.publicationRestrictions.sources) validateHistoricalSupport(career, { sources: [ref] });
      if (fact.publication !== 'prohibited') fail('INVALID_INPUT', 'Publication restrictions cannot be silently treated as permission.');
    }
    if (fact.publicationOrigin) {
      const origin = fact.publicationOrigin, interview = career.interviews?.[origin.interviewId];
      const response = interview?.responses?.find(item => item.id === origin.responseId), answer = response?.answers?.find(item => item.factId === fact.id);
      const permission = answer?.publication;
      if (origin.kind !== 'interview' || !permission || permission.value !== fact.publication ||
          (response.channel === 'chat' && (typeof permission.quote !== 'string' || typeof response.reply !== 'string' || !response.reply.includes(permission.quote))) ||
          (response.channel === 'form' && (response.reply?.action !== 'accept' || response.reply.content?.[`q${answer.number}_publication`] !== permission.value)))
        fail('INVALID_INPUT', 'Publication permission does not match the candidate’s recorded response.');
    }
  }
  if (career.roles !== undefined) {
    if (!career.roles || typeof career.roles !== 'object' || Array.isArray(career.roles)) fail('INVALID_INPUT', 'Invalid saved role map.');
    for (const [id, role] of Object.entries(career.roles)) {
      validate(roleSchema, role, 'Saved role');
      if (id !== role.id) fail('INVALID_INPUT', 'Saved role identity does not match its key.');
      for (const ref of role.sourceRefs) validateHistoricalSupport(career, { sources: [ref] });
      for (const factId of role.factIds ?? []) if (career.facts?.[factId] && career.facts[factId].roleId !== id) fail('INVALID_INPUT', 'Saved role fact belongs to another role.');
    }
  }
  if (career.cvReview !== undefined) {
    const review = career.cvReview;
    if (!review || typeof review !== 'object' || Array.isArray(review)) fail('INVALID_INPUT', 'Invalid saved CV review.');
    validate(sourceSetSchema, review.sourceSet, 'Review source set');
    validate(digest, review.sourceSetFingerprint, 'Review source fingerprint');
    if (review.completedSourceSetFingerprint !== null) validate(digest, review.completedSourceSetFingerprint, 'Completed review fingerprint');
    validate(array(uuid, 1000), review.reviewedSourceIds, 'Reviewed sources');
    if (hash(review.sourceSet) !== review.sourceSetFingerprint || (review.completedSourceSetFingerprint && review.completedSourceSetFingerprint !== review.sourceSetFingerprint)) fail('INVALID_INPUT', 'The saved source checkpoint is inconsistent.');
    if (!review.roles || typeof review.roles !== 'object' || Array.isArray(review.roles)) fail('INVALID_INPUT', 'Invalid saved role review map.');
    for (const [id, row] of Object.entries(review.roles)) {
      if (row.roleId !== id || !career.roles?.[id]) fail('INVALID_INPUT', 'Review names an unknown role.');
      for (const facet of CV_REVIEW_FACETS) {
        const state = row[facet];
        if (!state) fail('INVALID_INPUT', 'Review is missing a role facet.');
        validate(facetSchema, { status: state.status, ...(state.support ? { support: state.support } : {}) }, 'Saved review facet');
        if (state.support) validateHistoricalSupport(career, state.support, id);
        validate(digest, state.roleFingerprint, 'Role binding');
        validate(digest, state.evidenceFingerprint, 'Facet binding');
      }
    }
  }
  if (career.masterCv !== undefined) {
    const container = career.masterCv;
    if (!container || typeof container !== 'object' || !Array.isArray(container.history) || container.history.length > 10000) fail('INVALID_INPUT', 'Invalid saved master history.');
    if (!Object.hasOwn(container, 'current') || (!container.current && container.history.length)) fail('INVALID_INPUT', 'Saved master history requires its current version tip.');
    const versions = [...container.history, ...(container.current ? [container.current] : [])];
    let version = 0, userOwned = false;
    for (const master of versions) {
      if (!Number.isSafeInteger(master.version) || master.version > MAX_MASTER_VERSION || master.version <= version || !['agent', 'user'].includes(master.editedBy) || typeof master.userEdited !== 'boolean') fail('INVALID_INPUT', 'Invalid master version or ownership.');
      if ((userOwned || master.editedBy === 'user') && !master.userEdited) fail('INVALID_INPUT', 'Saved master history cannot discard user ownership.');
      userOwned ||= master.userEdited;
      version = master.version;
      validate(manualDocumentSchema, master.document, 'Saved master document');
      assertUniqueDocument(master.document);
      validate(presentationSchema, master.presentation, 'Saved master presentation');
      validate(savedDocumentEvidenceSchema, master.evidence, 'Saved master evidence');
      for (const support of Object.values(master.evidence)) if (Object.keys(support).length) validateHistoricalSupport(career, support);
      for (const field of ['sourceSetFingerprint', 'evidenceFingerprint', 'reviewFingerprint', 'policyId']) validate(digest, master[field], 'Saved master fingerprint');
      for (const field of ['createdAt', 'updatedAt']) if (!Number.isFinite(Date.parse(master[field]))) fail('INVALID_INPUT', 'Invalid master save date.');
      for (const claim of master.document.highlights ?? []) validateHistoricalSupport(career, claim.support);
      for (const role of master.document.experience) for (const claim of role.bullets) validateHistoricalSupport(career, claim.support, role.roleId);
    }
  }
  return career;
}
