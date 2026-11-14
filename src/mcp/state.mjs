import { createHash } from 'node:crypto';
import { canonicalJSON } from '../client.mjs';

export { canonicalJSON };
export const mutationSchema = Object.freeze({
  requestId: { type: 'string', format: 'uuid', description: 'UUID returned by request_id, not a descriptive label. Reuse only for an exact retry of the same mutation.' },
  revision: { type: 'integer', minimum: 0, description: 'Current revision from career_profile_read or the latest successful mutation; not matchingProfileVersion or a fact/evidence counter.' },
});
export const hash = value => createHash('sha256').update(canonicalJSON(value)).digest('hex');
export class CareerError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
export function fail(code, message) { throw new CareerError(code, message); }
export const CAREER_SCHEMA = 2;
export function createCareerState() {
  return { version: CAREER_SCHEMA, revision: 0, evidenceRevision: 0,
    profile: { name: null, firstName: null, lastName: null, preferredName: null, headline: null, email: null, phone: null,
      location: null, country: null, addressLine1: null, addressLine2: null, city: null, postalCode: null, linkedinUrl: null,
      links: [], roleCapabilities: [], seniority: null, skills: [], preferences: {} },
    sources: {}, facts: {}, applications: {}, receipts: {} };
}
/** Keep only the GitHub onboarding answers in introduction state. */
export function normalizeIntroductions(career) {
  const intro = career?.introductions;
  if (intro === undefined) return false;
  const next = {};
  if (typeof intro?.githubSkipped === 'boolean') next.githubSkipped = intro.githubSkipped;
  if (typeof intro?.githubRequestedAt === 'string') next.githubRequestedAt = intro.githubRequestedAt;
  if (JSON.stringify(intro) === JSON.stringify(next)) return false;
  career.introductions = next;
  return true;
}
/** One-time CV format cutover: retain saved wording and answers, discard bookkeeping. */
export function simplifyCvStorage(career) {
  if (!career || typeof career !== 'object') return;
  const oldRoles = career.roles ?? {};
  const masters = [...(Array.isArray(career.masterCv?.history) ? career.masterCv.history : []), ...(career.masterCv?.current ? [career.masterCv.current] : [])];
  const plainDocument = document => {
    if (!document || typeof document !== 'object') return;
    if (Array.isArray(document.highlights)) document.highlights = document.highlights.map(item => typeof item === 'string' ? item : item?.text);
    if (Array.isArray(document.experience)) for (const role of document.experience) {
      if (!role || typeof role !== 'object') continue;
      delete role.roleId;
      if (Array.isArray(role.bullets)) role.bullets = role.bullets.map(item => typeof item === 'string' ? item : item?.text);
    }
  };
  const old = Object.hasOwn(career, 'roles') || Object.hasOwn(career, 'cvReview') || masters.some(master => master && Object.hasOwn(master, 'evidence'));
  if (!old) return;
  for (const master of masters) {
    if (!master || typeof master !== 'object') continue;
    plainDocument(master.document);
    // An old document remains readable; rereading originals acknowledges its new source list.
    master.sourceIds ??= [];
    for (const key of ['evidence', 'sourceSetFingerprint', 'evidenceFingerprint', 'reviewFingerprint', 'policyId']) delete master[key];
  }
  for (const fact of Object.values(career.facts ?? {})) {
    if (!fact || typeof fact !== 'object') continue;
    const role = oldRoles[fact.roleId];
    if (role) {
      fact.employer ||= role.employer;
      fact.context = [fact.context, [role.title, role.startDate, role.endDate].filter(Boolean).join(' · ')].filter(Boolean).join('\n');
    }
    const restricted = [...(Array.isArray(fact.publicationRestrictions?.texts) ? fact.publicationRestrictions.texts : []),
      ...(Array.isArray(fact.publicationRestrictions?.sources) ? fact.publicationRestrictions.sources.map(ref => ref?.quote).filter(Boolean) : [])];
    if (restricted.length) fact.detail = [fact.detail, ...restricted].filter(Boolean).join('\n');
    for (const key of ['roleId', 'facet', 'resolution', 'resolutionOrigin', 'publicationOrigin', 'publicationRestrictions']) delete fact[key];
  }
  const plainQuestion = question => {
    if (!question || typeof question !== 'object') return;
    for (const key of ['roleId', 'facet', 'publicationRestrictions']) delete question[key];
  };
  for (const interview of Object.values(career.interviews ?? {})) {
    if (!interview || typeof interview !== 'object') continue;
    if (interview.target?.applicationId) interview.applicationId = interview.target.applicationId;
    delete interview.target;
    delete interview.contextFingerprint;
    for (const list of [interview.questions, interview.originalQuestions]) if (Array.isArray(list)) list.forEach(plainQuestion);
    if (Array.isArray(interview.responses)) for (const response of interview.responses) if (Array.isArray(response?.answers)) for (const answer of response.answers) {
      plainQuestion(answer?.question);
      if (!answer || typeof answer !== 'object') continue;
      delete answer.resolution;
      if (answer.publication && typeof answer.publication === 'object') answer.publication = answer.publication.value;
    }
  }
  for (const app of Object.values(career.applications ?? {})) {
    if (!app || typeof app !== 'object') continue;
    for (const draft of [app.cv, app.coverLetter, ...(Array.isArray(app.cvHistory) ? app.cvHistory : []), ...(Array.isArray(app.coverLetterHistory) ? app.coverLetterHistory : [])]) {
      if (!draft || typeof draft !== 'object') continue;
      plainDocument(draft.document);
      delete draft.evidence; delete draft.requirements;
    }
    for (const answer of Object.values(app.formAnswers ?? {})) if (answer && typeof answer === 'object') delete answer.support;
  }
  for (const draft of Object.values(career.formDrafts ?? {})) for (const answer of Object.values(draft?.answers ?? {})) if (answer && typeof answer === 'object') delete answer.support;
  delete career.roles;
  delete career.cvReview;
  career.receipts = {};
}
/** Schema cutover without migration: keeps CV sources and profile, discards everything else and invalidates evidence and rankings. */
export function upgradeCareer(old) {
  normalizeIntroductions(old);
  simplifyCvStorage(old);
  // Application prose is no longer a reusable profile fact.
  if (old?.profile && Object.hasOwn(old.profile, 'personalSummary')) delete old.profile.personalSummary;
  // Target roles live only in careerPaths; the old flat lists go and the agent derives paths again before the next search.
  if (old?.profile?.preferences) for (const field of ['roles', 'acceptedAlternatives']) delete old.profile.preferences[field];
  if (old?.version === CAREER_SCHEMA) return old;
  const fresh = createCareerState();
  return { ...fresh, profile: old?.profile ?? fresh.profile, sources: old?.sources ?? {},
    evidenceRevision: (old?.evidenceRevision ?? 0) + 1, rankingVersion: (old?.rankingVersion ?? 0) + 1 };
}
export function readCareer(store) { return store.get().career ?? createCareerState(); }
function preflight(career, { requestId, revision }, operation, input) {
  if (typeof requestId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId) || !Number.isSafeInteger(revision) || revision < 0)
    fail('INVALID_INPUT', 'Provide requestId as a UUID from request_id and revision as the integer returned by career_profile_read. Do not use a descriptive request label.');
  const inputHash = hash({ operation, input });
  const receipt = career.receipts[requestId];
  if (receipt) {
    if (receipt.operation !== operation || receipt.inputHash !== inputHash)
      fail('REQUEST_CONFLICT', 'This request ID was already used with different content. Read the saved state and use a new request ID.');
    return { receipt, inputHash };
  }
  if (career.revision !== revision) fail('REVISION_CONFLICT', 'The local profile changed. Read its current state and apply your change to the new revision.');
  return { receipt: null, inputHash };
}
export function replayCareer(store, mutation, operation, input) {
  return preflight(readCareer(store), mutation, operation, input).receipt?.result ?? null;
}
export async function mutateCareer(store, mutation, operation, input, change) {
  let result;
  await store.update(async state => {
    const career = state.career ??= createCareerState();
    const checked = preflight(career, mutation, operation, input);
    if (checked.receipt) { result = checked.receipt.result; return; }
    const data = await change(career, state);
    career.revision++;
    result = structuredClone({ ...data, revision: career.revision });
    if (Buffer.byteLength(JSON.stringify(result)) > 2 * 1024 * 1024) fail('RESULT_LIMIT', 'This result is too large. Request a smaller set of records.');
    // preflight accepts only UUID keys before invoking change; built-in property names cannot reach this write.
    career.receipts[mutation.requestId] = { operation, inputHash: checked.inputHash, result: structuredClone(result), createdAt: new Date().toISOString() };
  });
  return result;
}
