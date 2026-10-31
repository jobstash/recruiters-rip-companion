import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { createCareerState, fail, readCareer } from './state.mjs';
import { ESSENTIAL_PREFERENCES, missingPreferences, salaryEligibility, matchingProfileVersion } from './assessment-policy.mjs';
import {
  ASSESSMENT_POLICY_ID, BANDS, DIMENSION_WEIGHTS, MATCHING_PROTOCOL, MATCHING_TOOL_DESCRIPTIONS, RECOMMEND_MINIMUM,
  RERANK_POLICY, RERANK_SIZE, assessmentSchema, comparisonSchema, deriveDecision, idSchema,
} from './matching-contract.mjs';
import { compareFacts } from './facts.mjs';
import { reviewInclusion, savedPublicationRange } from './review-queue.mjs';
import { assertJobNotBlocked, blockFilter } from './blocklist.mjs';
import { completeLocalJobs, localJob, localJobMetadata, localJobOriginal } from './job-tools.mjs';
import { publicationInWindow, publicationWindowForRange } from './publication-range.mjs';

const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const object = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const decisions = ['recommend', 'clarify', 'skip'];
const profileVersionSchema = { type: 'string', pattern: '^[0-9]+:[0-9]+$', maxLength: 80 };
const policyIdSchema = { type: 'string', minLength: 1, maxLength: 80 };
const ajv = new Ajv({ strict: false, allErrors: false });
addFormats(ajv);
const validAssessments = ajv.compile({ type: 'array', items: assessmentSchema, minItems: 1, maxItems: 10 });
const validComparisons = ajv.compile({ type: 'array', items: comparisonSchema, minItems: 1, maxItems: 15 });
const profileFields = ['headline', 'location', 'roleCapabilities', 'seniority', 'skills'];
const preferenceFields = ['roles', 'acceptedAlternatives', 'excludedRoles', 'locations', 'workModes', 'employmentTypes',
  'salaryMinimum', 'salaryCurrency', 'salaryPeriod', 'requiresSponsorship', 'willingToRelocate', 'companySizes', 'companyStages',
  'responsibilityModes', 'directReports', 'travel', 'availability', 'emphasis', 'technologies', 'domains', 'notes'];
const compareText = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const date = value => Number.isFinite(Date.parse(value)) ? Date.parse(value) : -Infinity;
const newerFirst = (a, b) => date(a.publishedAt) === date(b.publishedAt) ? 0 : date(a.publishedAt) > date(b.publishedAt) ? -1 : 1;
const byOverall = (a, b) => (b.overall ?? -1) - (a.overall ?? -1) || newerFirst(a, b) || compareText(a.id, b.id);
const matching = career => {
  const saved = { jobs: {}, scores: {}, pairs: {}, ...career.matching };
  return { ...saved, jobs: { ...saved.jobs, ...Object.fromEntries(completeLocalJobs(career).map(job => [job.id, job])) } };
};
const writableMatching = career => {
  const saved = career.matching ??= { jobs: {}, scores: {} };
  saved.pairs ??= {};
  return saved;
};
const rankingVersion = career => career.rankingVersion ?? 0;
const currentProfileVersion = matchingProfileVersion;

export async function deleteRankings(store) {
  let result;
  await store.update(state => {
    const career = state.career ??= createCareerState(), saved = matching(career);
    result = { deletedRankings: Object.keys(saved.scores).length, deletedJobs: Object.values(saved.jobs).filter(job => !job.imported).length };
    career.rankingVersion = rankingVersion(career) + 1;
    career.matching = { jobs: {}, scores: {}, pairs: {} };
    delete career.prescan;
    delete career.prescanInclusion;
    delete career.reviewOverrides;
  });
  return result;
}

function assertCurrentWindow(jobs, ids, window) {
  if (ids.some(id => !jobs[id]?.imported && !publicationInWindow(jobs[id]?.publishedAt, window)))
    fail('OUTSIDE_PUBLICATION_WINDOW', 'These jobs are outside the selected publication range. Refresh the catalogue and continue with its current IDs.');
}

// JobStash seniority codes; stored rows already carry labels, so labels pass through unchanged.
const seniorityLabels = { 1: 'Intern', 2: 'Junior', 3: 'Senior', 4: 'Lead', 5: 'Head' };
const seniorityLabel = value => {
  const key = typeof value === 'string' ? value.trim() : '';
  return seniorityLabels[key] ?? (Object.values(seniorityLabels).includes(key) ? key : null);
};
const titleCase = value => typeof value === 'string' && value.trim()
  ? value.trim().toLowerCase().split(/[\s_]+/).map(word => word[0].toUpperCase() + word.slice(1)).join(' ')
  : null;

function displayTerms(job) {
  const text = value => typeof value === 'string' && value.trim() ? value : null;
  const salary = job.salary;
  return {
    salary: salary && typeof salary === 'object' && !Array.isArray(salary) ? {
      minimum: Number.isFinite(salary.minimum) ? salary.minimum : null,
      maximum: Number.isFinite(salary.maximum) ? salary.maximum : null,
      stated: Number.isFinite(salary.stated) ? salary.stated : null,
      currency: text(salary.currency),
      period: text(salary.period),
    } : null,
    city: text(job.city), location: text(job.location), workMode: text(job.workMode),
    seniority: seniorityLabel(job.seniority), commitment: titleCase(job.commitment),
    classification: titleCase(job.classification),
  };
}

function assertObject(value, allowed, required = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some(key => !allowed.includes(key)) || required.some(key => !own(value, key)))
    fail('INVALID_INPUT', `Provide an object with only ${allowed.join(', ') || 'no fields'}.`);
}
function assertIds(ids) {
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > 10 || new Set(ids).size !== ids.length ||
      ids.some(id => typeof id !== 'string' || !id.trim() || id.length > 500))
    fail('INVALID_INPUT', 'Provide one to ten distinct job IDs from career_match_jobs.');
}
function assertKnown(jobs, ids) {
  if (ids.some(id => !own(jobs, id))) fail('UNKNOWN_JOB', 'An ID is not in the saved catalogue. Read career_match_jobs and use its job IDs.');
}
function assertSchema(validate, value, label) {
  if (validate(value)) return;
  const issue = validate.errors[0];
  const location = `${label}${issue.instancePath}`;
  fail('INVALID_INPUT', issue.keyword === 'required' ? `${location} requires ${issue.params.missingProperty}. Use the advertised schema.`
    : issue.keyword === 'enum' ? `${location} must be one of ${issue.params.allowedValues.join(', ')}.`
      : `${location} ${issue.message}. Use the advertised schema.`);
}
function assertTokens(args) {
  if (typeof args.profileVersion !== 'string' || !/^[0-9]+:[0-9]+$/.test(args.profileVersion))
    fail('INVALID_INPUT', 'Use profileVersion from the current career_match_jobs context.');
  if (args.policyId !== ASSESSMENT_POLICY_ID)
    fail('POLICY_CHANGED', 'The assessment rubric changed. Call career_match_jobs and reassess with the current assessmentPolicy.');
}
function assertProfile(career, profileVersion) {
  if (profileVersion !== currentProfileVersion(career))
    fail('PROFILE_CHANGED', 'Candidate data or the ranking context changed. Call career_match_jobs and reassess affected jobs using its current profileVersion; do not reuse a token from before deleting rankings.');
}
function compact(value, maximum = 600) {
  if (typeof value === 'string') return value.replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[contact omitted]')
    .replace(/https?:\/\/\S+/gi, '[link omitted]').trim().slice(0, maximum);
  if (Array.isArray(value)) return value.map(item => compact(item, maximum));
  return value;
}
/** The CV exactly as assessment workers see it, so their quotes can be checked against it. */
function candidateCv(career) {
  return Object.values(career.sources ?? {}).filter(source => source.purpose === 'cv' && !source.archived && source.text?.trim())
    .map(source => compact(source.text, Infinity)).join('\n\n');
}
export function candidateContext(career) {
  const profile = career.profile ?? {};
  const professional = {};
  for (const field of profileFields) if (profile[field] != null && !(Array.isArray(profile[field]) && !profile[field].length)) professional[field] = compact(profile[field]);
  const preferences = {};
  for (const field of preferenceFields) if (own(profile.preferences ?? {}, field))
    preferences[field] = compact(profile.preferences[field], field === 'notes' ? Infinity : 600);
  const cv = candidateCv(career);
  const facts = Object.values(career.facts ?? {}).sort(compareFacts)
    .map(({ id, kind, subject, answer, detail, employer, question, context, applicationId, followUps }) => ({
      ...(id ? { id } : {}), kind, subject: compact(subject), answer: compact(answer),
      ...(detail ? { detail: compact(detail, Infinity) } : {}), ...(employer ? { employer: compact(employer) } : {}),
      ...(question ? { question: compact(question) } : {}), ...(context ? { context: compact(context) } : {}),
      ...(applicationId ? { applicationId } : {}),
      ...(followUps ? { followUps: followUps.map(exchange => ({
        question: compact(exchange.question), answer: compact(exchange.answer, Infinity),
        ...(exchange.context ? { context: compact(exchange.context) } : {}),
        ...(exchange.applicationId ? { applicationId: exchange.applicationId } : {}),
      })) } : {}),
    }));
  if (!(professional.headline?.trim() || professional.roleCapabilities?.length) || (!cv && !facts.length))
    fail('PROFILE_INCOMPLETE', 'Save a professional headline or roleCapabilities, and import a CV with career_source_import or save career facts with career_facts_save, before matching.');
  const missing = missingPreferences(career);
  if (missing.length) fail('PREFERENCES_REQUIRED', `Before any review, ask the candidate: ${missing.map(field => ESSENTIAL_PREFERENCES[field]).join(' ')} Save every answer with career_preferences_update (fields: ${missing.join(', ')}), read career_profile_read to confirm, then continue.`);
  return { ...professional, ...(cv ? { cv } : {}), facts, preferences };
}

/** Quote comparison tolerant of typography, bullets, spacing and case, never of rewording. */
export function normalizeQuote(text) {
  return String(text).normalize('NFKC').replace(/[‘’]/g, '\'').replace(/[“”]/g, '"')
    .replace(/^[\s•*\-–]+/, '').replace(/\s+/g, ' ').toLowerCase().trim();
}

/** Evidence citations must point at the saved CV or saved facts. Returns null or the first problem. */
export function validateCitations(career, row, cv = normalizeQuote(candidateCv(career))) {
  if (row.status !== 'assessed') return null;
  for (const { requirement, evidence, cvQuote, factIds = [] } of row.requirements) {
    const label = `${row.id} requirement "${requirement}"`;
    if (['demonstrated', 'transferable'].includes(evidence) && !cvQuote && !factIds.length)
      return { code: 'UNSUPPORTED_REQUIREMENT', message: `${label}: cite cvQuote or factIds for demonstrated/transferable evidence.` };
    if (cvQuote && !cv.includes(normalizeQuote(cvQuote)))
      return { code: 'UNKNOWN_QUOTE', message: `${label}: this quote is not in the saved CV: "${cvQuote.slice(0, 80)}". Quote the CV verbatim.` };
    const unknown = factIds.find(id => !own(career.facts ?? {}, id));
    if (unknown) return { code: 'UNKNOWN_FACT', message: `${label}: fact ${unknown} is not saved. Cite IDs from candidate.facts.` };
  }
  return null;
}

export function currentAssessment(row, profileVersion) {
  return typeof row?.profileVersion === 'string' && row.profileVersion === profileVersion &&
    row.policyId === ASSESSMENT_POLICY_ID && decisions.includes(row.decision);
}

function counts(jobs, scores, profileVersion) {
  let scored = 0, unavailable = 0, reviewed = 0, needsReview = 0;
  for (const row of Object.values(scores)) {
    if (row.status === 'unavailable') unavailable++;
    else scored++;
    if (currentAssessment(row, profileVersion)) reviewed++;
    else needsReview++;
  }
  return { scored, pending: Object.keys(jobs).filter(id => !own(scores, id)).length, unavailable, reviewed, needsReview };
}

function matchStatus(assessment, willingToRelocate) {
  if (assessment.status === 'unavailable') return 'unavailable';
  if (Object.values(assessment.gates ?? {}).includes('fail')) return 'excluded';
  if (assessment.relocation === 'not_required') return 'eligible';
  if (assessment.relocation === 'required') {
    if (willingToRelocate === true) return 'requires_relocation';
    if (willingToRelocate === false) return 'incompatible_location';
  }
  return 'needs_location_confirmation';
}

const matchPriority = {
  eligible: 0, requires_relocation: 0, needs_location_confirmation: 1,
  incompatible_location: 2, excluded: 3, unavailable: 4,
};

/** A comparison counts only while both assessments it judged are unchanged and current. */
function currentPair(pair, scores, profileVersion) {
  return pair.profileVersion === profileVersion && pair.policyId === ASSESSMENT_POLICY_ID &&
    scores[pair.a]?.scoredAt === pair.aScoredAt && scores[pair.b]?.scoredAt === pair.bScoredAt;
}
function pairwiseStats(saved, profileVersion) {
  const stats = new Map();
  const add = (id, wins) => {
    const entry = stats.get(id) ?? { wins: 0, compared: 0 };
    entry.wins += wins; entry.compared++;
    stats.set(id, entry);
  };
  for (const pair of Object.values(saved.pairs)) if (currentPair(pair, saved.scores, profileVersion)) {
    add(pair.a, pair.preferred === 'a' ? 1 : pair.preferred === 'equal' ? 0.5 : 0);
    add(pair.b, pair.preferred === 'b' ? 1 : pair.preferred === 'equal' ? 0.5 : 0);
  }
  return stats;
}

// Blocked jobs (see blocklist.mjs) leave every agent-facing view of saved assessments.
function rankedRows(career, profileVersion) {
  const saved = matching(career), preferences = career.profile?.preferences, blocked = blockFilter(career);
  const willingToRelocate = preferences?.willingToRelocate;
  const stats = pairwiseStats(saved, profileVersion);
  const rows = Object.entries(saved.scores).filter(([id]) => !blocked({ id, ...saved.jobs[id] })).map(([id, assessment]) => {
    const job = saved.jobs[id] ?? {};
    const { profileVersion: _version, policyId: _policy, host: _host, ...visibleAssessment } = assessment;
    const pairwise = stats.get(id);
    return { title: null, company: null, publishedAt: null, applyUrl: null,
      ...job, ...visibleAssessment, id, decision: decisions.includes(assessment.decision) ? assessment.decision : null,
      reviewStatus: currentAssessment(assessment, profileVersion) ? 'current' : 'needs_review',
      ...displayTerms(job), salaryEligibility: salaryEligibility(preferences, job.salary),
      matchStatus: matchStatus(assessment, willingToRelocate),
      ...(pairwise ? { pairwiseWins: pairwise.wins, pairwiseCompared: pairwise.compared } : {}) };
  });
  rows.sort((a, b) => matchPriority[a.matchStatus] - matchPriority[b.matchStatus] || byOverall(a, b));
  return rows;
}

const recommendable = (row, window) => row.reviewStatus === 'current' && row.decision === 'recommend' &&
  (row.imported || publicationInWindow(row.publishedAt, window)) && row.salaryEligibility.status !== 'below_minimum' &&
  ['eligible', 'requires_relocation'].includes(row.matchStatus);

/** The top current recommendations by overall fit and every pair among them still awaiting a judgment. */
function rerankSet(career, window) {
  const saved = matching(career), profileVersion = currentProfileVersion(career);
  const candidates = rankedRows(career, profileVersion).filter(row => recommendable(row, window))
    .sort(byOverall).slice(0, RERANK_SIZE);
  const judged = new Set(Object.values(saved.pairs).filter(pair => currentPair(pair, saved.scores, profileVersion))
    .map(pair => `${pair.a}|${pair.b}`));
  const ids = candidates.map(row => row.id).sort(compareText);
  const pairs = ids.flatMap((a, index) => ids.slice(index + 1).map(b => ({ a, b })));
  const open = pairs.filter(({ a, b }) => !judged.has(`${a}|${b}`));
  return { profileVersion, candidates, pairs: open, judged: pairs.length - open.length, total: pairs.length };
}

function escapedCSV(value) {
  let text = value == null ? '' : String(value);
  // Quoting alone does not stop spreadsheets from evaluating formulas.
  if (/^[\s\u0000-\u001f]*[=+\-@]|^[\t\r\n]/u.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

function rankingCSV(rows) {
  const columns = ['id', 'title', 'company', 'overall', 'band', 'direction', 'capability', 'scope', 'preferences',
    'directionGate', 'constraintsGate', 'eligibilityGate', 'publishedAt', 'salaryMinimum', 'salaryMaximum',
    'salaryStated', 'salaryCurrency', 'salaryPeriod', 'city', 'location', 'workMode', 'seniority', 'commitment',
    'classification', 'relocation', 'matchStatus', 'decision', 'reviewStatus', 'pairwiseWins', 'reason', 'applyUrl'];
  return Buffer.from([columns, ...rows.map(row => [row.id, row.title, row.company, row.overall, row.band,
    row.dimensions?.direction, row.dimensions?.capability, row.dimensions?.scope, row.dimensions?.preferences,
    row.gates?.direction, row.gates?.constraints, row.gates?.eligibility, row.publishedAt,
    row.salary?.minimum, row.salary?.maximum, row.salary?.stated, row.salary?.currency, row.salary?.period,
    row.city, row.location, row.workMode, row.seniority, row.commitment, row.classification, row.relocation,
    row.matchStatus, row.decision, row.reviewStatus, row.pairwiseWins, row.reason, row.applyUrl])]
    .map(row => row.map(escapedCSV).join(',')).join('\r\n') + '\r\n', 'utf8');
}

function page(args) {
  assertObject(args, ['limit', 'offset']);
  const { limit = 25, offset = 0 } = args;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger(offset) || offset < 0)
    fail('INVALID_INPUT', 'Use limit 1–100 and a nonnegative integer offset.');
  return { limit, offset };
}

/** Validate and normalize the complete current feed without reading or changing career data. */
export function matchingCatalogueJobs(catalogue, window) {
  if (!Array.isArray(catalogue?.jobs) || catalogue.total !== catalogue.jobs.length ||
      new Set(catalogue.jobs.map(job => job?.id)).size !== catalogue.jobs.length || catalogue.jobs.some(job =>
        !job || typeof job.id !== 'string' || !job.id.startsWith('node:') || typeof job.title !== 'string' ||
        typeof job.company !== 'string' || !publicationInWindow(job.publishedAt, window)))
    fail('INVALID_CATALOGUE', 'The platform returned an incomplete catalogue. No new rankings were saved; request the catalogue again.');
  const jobs = catalogue.jobs.map(job => {
    const { id, title, company, publishedAt, applyUrl, logoUrl } = job;
    return { id, title, company, publishedAt, ...(typeof applyUrl === 'string' ? { applyUrl } : {}),
      ...(typeof logoUrl === 'string' && /^https:\/\//.test(logoUrl) && logoUrl.length <= 2000 ? { logoUrl } : {}), ...displayTerms(job) };
  });
  return { jobs, window, total: catalogue.total };
}

/** Transport pages throttle metadata transfer, never the finite catalogue's total coverage. */
export async function loadMatchingCatalogue(platform, window) {
  const jobs = [];
  let offset = 0, total;
  for (;;) {
    const page = await platform('matching_catalogue', { publicationRange: window.range, since: window.since, until: window.until,
      ...(offset ? { offset } : {}) });
    if (!Array.isArray(page?.jobs) || !Number.isSafeInteger(page.total) || page.total < 0 ||
        (total !== undefined && page.total !== total) ||
        page.publicationWindow?.range !== window.range || page.publicationWindow?.since !== window.since ||
        page.publicationWindow?.until !== window.until ||
        (page.nextOffset !== null && (!Number.isSafeInteger(page.nextOffset) || page.nextOffset <= offset)))
      fail('INVALID_CATALOGUE', 'The platform returned an incomplete catalogue. Request the catalogue again.');
    total = page.total;
    for (const job of page.jobs) jobs.push(job);
    if (jobs.length > total || (page.nextOffset !== null && page.nextOffset !== jobs.length) ||
        (page.nextOffset === null && jobs.length !== total) || (page.nextOffset !== null && jobs.length >= total))
      fail('INVALID_CATALOGUE', 'The platform returned an incomplete catalogue. Request the catalogue again.');
    if (page.nextOffset === null) return matchingCatalogueJobs({ jobs, total }, window);
    offset = page.nextOffset;
  }
}

/** Companion's own load for the Jobs tab: the selected window's feed replaces the cached feed. Every saved review keeps the
 *  job it reviews, so narrowing the window never discards the agent's work; `window` lets Jobs show only this window. */
export function replaceFeedCache(career, jobs, window) {
  const previous = career.matching ?? {}, scores = previous.scores ?? {};
  const reviewed = Object.fromEntries(Object.entries(previous.jobs ?? {}).filter(([id]) => own(scores, id)));
  career.matching = { ...previous, jobs: { ...reviewed, ...Object.fromEntries(jobs.map(job => [job.id, job])) },
    scores, pairs: previous.pairs ?? {}, window };
}

export function createMatchingTools({ store, platform, exportDocument }) {
  const describe = name => MATCHING_TOOL_DESCRIPTIONS[name];
  const publicationScope = () => publicationWindowForRange(savedPublicationRange(store.get().career ?? {}));
  return [
    {
      name: 'career_rankings_delete', description: describe('career_rankings_delete'),
      inputSchema: object({}), readOnly: false,
      async invoke(args = {}) { assertObject(args, []); return deleteRankings(store); },
    },
    {
      name: 'career_match_jobs', description: describe('career_match_jobs'),
      inputSchema: object({ refresh: { type: 'boolean' }, localOnly: { type: 'boolean', description: 'Discover only complete locally captured jobs, without accessing the platform feed.' } }), readOnly: false,
      async invoke(args = {}) {
        assertObject(args, ['refresh', 'localOnly']);
        for (const field of ['refresh', 'localOnly']) if (args[field] !== undefined && typeof args[field] !== 'boolean') fail('INVALID_INPUT', `${field} must be a boolean.`);
        candidateContext(readCareer(store));
        if (args.refresh) await deleteRankings(store);
        const fetchVersion = rankingVersion(readCareer(store));
        const window = publicationScope();
        const { jobs } = args.localOnly ? { jobs: [] } : await loadMatchingCatalogue(platform, window);
        let result;
        await store.update(state => {
          const career = state.career ??= createCareerState();
          const candidate = candidateContext(career);
          if (rankingVersion(career) !== fetchVersion)
            fail('RANKINGS_CHANGED', 'Rankings were deleted while the catalogue was loading. Request the current catalogue; discarded results were not restored.');
          const previous = career.matching;
          const currentJobs = Object.fromEntries([...jobs, ...completeLocalJobs(career)].map(job => [job.id, job]));
          const currentScores = Object.fromEntries(Object.entries(previous?.scores ?? {}).filter(([id]) => own(currentJobs, id)));
          const keepArchive = args.localOnly;
          const scores = keepArchive ? previous?.scores ?? {} : currentScores;
          const retainedJobs = keepArchive
            ? Object.fromEntries(Object.entries(previous?.jobs ?? {}).filter(([id]) => own(scores, id) && !own(currentJobs, id)))
            : {};
          const pairs = Object.fromEntries(Object.entries(previous?.pairs ?? {})
            .filter(([, pair]) => own(scores, pair.a) && own(scores, pair.b)));
          const saved = career.matching = { jobs: { ...retainedJobs, ...currentJobs }, scores, pairs };
          const profileVersion = matchingProfileVersion(career);
          const candidates = Object.keys(currentJobs).filter(id => !currentAssessment(saved.scores[id], profileVersion));
          const inclusion = reviewInclusion(career, candidates);
          result = { candidate, profileVersion, policyId: ASSESSMENT_POLICY_ID, evidenceRevision: career.evidenceRevision ?? 0,
            publicationWindow: window,
            assessmentPolicy: { protocol: MATCHING_PROTOCOL, weights: DIMENSION_WEIGHTS, bands: BANDS, recommendMinimum: RECOMMEND_MINIMUM },
            assessmentSchema,
            jobIds: [...inclusion.includedIds], excluded: inclusion.candidates - inclusion.includedIds.size, blocked: inclusion.blocked,
            total: Object.keys(currentJobs).length, ...counts(currentJobs, currentScores, profileVersion), batchSize: 10, workers: 8 };
        });
        return result;
      },
    },
    {
      name: 'career_match_batch', description: describe('career_match_batch'),
      inputSchema: object({ ids: { type: 'array', items: idSchema, minItems: 1, maxItems: 10, uniqueItems: true } }, ['ids']), readOnly: false,
      async invoke(args = {}) {
        assertObject(args, ['ids'], ['ids']);
        assertIds(args.ids);
        const before = readCareer(store), fetchVersion = rankingVersion(before), saved = matching(before);
        // Every batch carries the saved candidate, so reviewers in a new session or after compaction assess against the
        // companion's current CV, facts and preferences rather than remembered ones. It also refuses unanswered basics.
        const candidate = candidateContext(before), profileVersion = currentProfileVersion(before);
        for (const id of args.ids) assertJobNotBlocked(before, id);
        for (const id of args.ids) if (id.startsWith('local:')) localJobOriginal(before, id, true);
        assertKnown(saved.jobs, args.ids);
        assertCurrentWindow(saved.jobs, args.ids, publicationScope());
        const local = args.ids.filter(id => localJob(before, id)).map(id => localJobOriginal(before, id, true));
        const platformIds = args.ids.filter(id => !id.startsWith('local:'));
        const result = platformIds.length ? await platform('matching_jobs', { ids: platformIds })
          : { jobs: [], remainingIds: [], unavailableIds: [] };
        if (!Array.isArray(result?.jobs) || !Array.isArray(result.remainingIds) || !Array.isArray(result.unavailableIds))
          fail('INVALID_BATCH', 'The platform did not report job availability. Retry career_match_batch; saved assessments are unchanged.');
        const covered = [...result.jobs.map(job => job?.id), ...result.remainingIds, ...result.unavailableIds];
        if (covered.length !== platformIds.length || new Set(covered).size !== covered.length || covered.some(id => !platformIds.includes(id)))
          fail('INVALID_BATCH', 'The platform response did not account for every requested job. Retry career_match_batch.');
        if (result.jobs.length) await store.update(state => {
          if (rankingVersion(state.career) !== fetchVersion)
            fail('RANKINGS_CHANGED', 'Rankings were deleted while job details were loading. Discarded jobs were not restored.');
          for (const job of result.jobs) assertJobNotBlocked(state.career, job.id, job);
          const saved = writableMatching(state.career ??= createCareerState());
          for (const job of result.jobs) {
            const metadata = saved.jobs[job.id] ??= { id: job.id, title: null, company: null, publishedAt: null, applyUrl: null };
            for (const field of ['title', 'publishedAt', 'applyUrl'])
              if (typeof job[field] === 'string') metadata[field] = job[field];
            const company = typeof job.company === 'string' ? job.company : job.company?.name;
            if (typeof company === 'string') metadata.company = company;
            Object.assign(metadata, displayTerms(job));
          }
        });
        const current = readCareer(store);
        for (const id of args.ids) assertJobNotBlocked(current, id);
        for (const job of [...result.jobs, ...local]) assertJobNotBlocked(current, job.id, job);
        return { ...result, jobs: [...result.jobs, ...local], candidate, profileVersion };
      },
    },
    {
      name: 'career_match_save', description: describe('career_match_save'),
      inputSchema: object({
        profileVersion: profileVersionSchema, policyId: policyIdSchema,
        assessments: { type: 'array', items: assessmentSchema, minItems: 1, maxItems: 10 },
      }, ['profileVersion', 'policyId', 'assessments']), readOnly: false,
      async invoke(args = {}, context = {}) {
        assertObject(args, ['profileVersion', 'policyId', 'assessments'], ['profileVersion', 'policyId', 'assessments']);
        assertTokens(args);
        assertSchema(validAssessments, args.assessments, 'assessments');
        const ids = args.assessments.map(row => row.id);
        assertIds(ids);
        const client = context?.client;
        const host = client && typeof client.name === 'string' ? { name: client.name, version: typeof client.version === 'string' ? client.version : null } : null;
        await store.update(state => {
          const career = state.career ??= createCareerState();
          for (const id of ids) assertJobNotBlocked(career, id);
          assertProfile(career, args.profileVersion);
          const saved = writableMatching(career);
          const allJobs = matching(career).jobs;
          for (const id of ids) if (id.startsWith('local:')) {
            localJobOriginal(career, id, true);
            saved.jobs[id] = localJobMetadata(localJob(career, id));
          }
          assertKnown({ ...allJobs, ...saved.scores }, ids);
          assertCurrentWindow(allJobs, ids, publicationScope());
          const cv = normalizeQuote(candidateCv(career));
          for (const row of args.assessments) {
            const problem = validateCitations(career, row, cv);
            if (problem) fail(problem.code, problem.message);
            const pay = salaryEligibility(career.profile?.preferences, saved.jobs[row.id]?.salary);
            if (row.status === 'assessed' && pay.status === 'below_minimum' && row.gates.constraints !== 'fail')
              fail('SALARY_BELOW_MINIMUM', `${row.id}: stated pay ceiling ${pay.upperBound} ${pay.currency}/${pay.period} is below the minimum ${pay.minimum}. Record gates.constraints fail.`);
          }
          const scoredAt = new Date().toISOString();
          for (const row of args.assessments) {
            saved.scores[row.id] = { ...row, ...deriveDecision(row), profileVersion: args.profileVersion, policyId: ASSESSMENT_POLICY_ID, scoredAt, host };
            for (const [key, pair] of Object.entries(saved.pairs)) if (pair.a === row.id || pair.b === row.id) delete saved.pairs[key];
          }
        });
        return { saved: args.assessments.length };
      },
    },
    {
      name: 'career_matches', description: describe('career_matches'),
      inputSchema: object({ limit: { type: 'integer', minimum: 1, maximum: 100 }, offset: { type: 'integer', minimum: 0 } }), readOnly: true,
      async invoke(args = {}) {
        const { limit, offset } = page(args);
        const career = readCareer(store), saved = matching(career);
        const profileVersion = currentProfileVersion(career);
        const rows = rankedRows(career, profileVersion);
        const matches = rows.slice(offset, offset + limit);
        return { view: 'assessment_archive', matches, total: rows.length, policyId: ASSESSMENT_POLICY_ID,
          nextOffset: offset + matches.length < rows.length ? offset + matches.length : null,
          ...counts(saved.jobs, saved.scores, profileVersion) };
      },
    },
    {
      name: 'career_recommendations', description: describe('career_recommendations'),
      inputSchema: object({ limit: { type: 'integer', minimum: 1, maximum: 100 }, offset: { type: 'integer', minimum: 0 } }), readOnly: true,
      async invoke(args = {}) {
        const { limit, offset } = page(args);
        const career = readCareer(store), saved = matching(career), profileVersion = currentProfileVersion(career);
        const window = publicationScope();
        const rows = rankedRows(career, profileVersion).filter(row => recommendable(row, window));
        // Pairwise-judged rows lead by wins; unjudged rows keep overall-fit order.
        const compared = rows.filter(row => row.pairwiseCompared > 0)
          .sort((a, b) => b.pairwiseWins - a.pairwiseWins || byOverall(a, b));
        const ordered = [...compared, ...rows.filter(row => !(row.pairwiseCompared > 0))];
        const recommendations = ordered.slice(offset, offset + limit);
        const { judged, total } = rerankSet(career, window);
        return { recommendations, total: ordered.length, policyId: ASSESSMENT_POLICY_ID, rerank: { judged, total },
          nextOffset: offset + recommendations.length < ordered.length ? offset + recommendations.length : null,
          ...counts(saved.jobs, saved.scores, profileVersion) };
      },
    },
    {
      name: 'career_rerank_pairs', description: describe('career_rerank_pairs'),
      inputSchema: object({}), readOnly: true,
      async invoke(args = {}) {
        assertObject(args, []);
        const { profileVersion, candidates, pairs, judged, total } = rerankSet(readCareer(store), publicationScope());
        return { profileVersion, policyId: ASSESSMENT_POLICY_ID, rerankPolicy: RERANK_POLICY,
          candidates: candidates.map(({ id, title, company, overall, band, dimensions, gates, requirements, reason }) =>
            ({ id, title, company, overall, band, dimensions, gates, requirements, reason })),
          pairs, judged, total };
      },
    },
    {
      name: 'career_rerank_save', description: describe('career_rerank_save'),
      inputSchema: object({
        profileVersion: profileVersionSchema, policyId: policyIdSchema,
        comparisons: { type: 'array', items: comparisonSchema, minItems: 1, maxItems: 15 },
      }, ['profileVersion', 'policyId', 'comparisons']), readOnly: false,
      async invoke(args = {}) {
        assertObject(args, ['profileVersion', 'policyId', 'comparisons'], ['profileVersion', 'policyId', 'comparisons']);
        assertTokens(args);
        assertSchema(validComparisons, args.comparisons, 'comparisons');
        if (args.comparisons.some(({ a, b }) => a === b)) fail('INVALID_INPUT', 'Compare two different jobs: a and b must differ.');
        let result;
        await store.update(state => {
          const career = state.career ??= createCareerState();
          for (const { a, b } of args.comparisons) {
            assertJobNotBlocked(career, a);
            assertJobNotBlocked(career, b);
          }
          assertProfile(career, args.profileVersion);
          const saved = writableMatching(career);
          const members = new Set(rerankSet(career, publicationScope()).candidates.map(row => row.id));
          if (args.comparisons.some(({ a, b }) => !members.has(a) || !members.has(b)))
            fail('NOT_IN_RERANK_SET', 'Call career_rerank_pairs and compare only its candidates.');
          const comparedAt = new Date().toISOString();
          for (const comparison of args.comparisons) {
            const reversed = compareText(comparison.a, comparison.b) > 0;
            const [a, b] = reversed ? [comparison.b, comparison.a] : [comparison.a, comparison.b];
            const preferred = !reversed || comparison.preferred === 'equal' ? comparison.preferred : comparison.preferred === 'a' ? 'b' : 'a';
            saved.pairs[`${a}|${b}`] = { a, b, preferred, decisive: comparison.decisive, reason: comparison.reason,
              profileVersion: args.profileVersion, policyId: ASSESSMENT_POLICY_ID,
              aScoredAt: saved.scores[a].scoredAt, bScoredAt: saved.scores[b].scoredAt, comparedAt };
          }
          result = { saved: args.comparisons.length, remaining: rerankSet(career, publicationScope()).pairs.length };
        });
        return result;
      },
    },
    {
      name: 'career_matches_export', description: describe('career_matches_export'),
      inputSchema: object({}), readOnly: false,
      async invoke(args = {}) {
        assertObject(args, []);
        if (typeof exportDocument !== 'function') fail('EXPORT_UNAVAILABLE', 'Local document export is unavailable. Read all career_matches pages instead.');
        const career = readCareer(store), saved = matching(career);
        const profileVersion = currentProfileVersion(career);
        const rows = rankedRows(career, profileVersion);
        const coverage = counts(saved.jobs, saved.scores, profileVersion);
        const exported = await exportDocument({ bytes: rankingCSV(rows), mediaType: 'text/csv' });
        const current = readCareer(store);
        for (const row of rows) assertJobNotBlocked(current, row.id, row);
        return { view: 'assessment_archive', total: rows.length, ...coverage, export: { ...exported, mediaType: 'text/csv' } };
      },
    },
  ];
}
