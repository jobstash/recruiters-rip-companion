import { createCareerState, fail, readCareer } from './state.mjs';
import { ASSESSMENT_VERSION, COMPETENCY_POLICY, SALARY_POLICY, salaryEligibility, recentPublication, publicationWindow, matchingProfileVersion } from './assessment-policy.mjs';
import { compareFacts } from './facts.mjs';

const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const object = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const idSchema = { type: 'string', minLength: 1, maxLength: 500 };
const relocation = ['required', 'not_required', 'unclear'];
const decisions = ['recommend', 'clarify', 'skip'];
const scoreSchema = object({
  id: idSchema, score: { anyOf: [{ type: 'integer', minimum: 0, maximum: 100 }, { type: 'null' }] },
  reason: { type: 'string', minLength: 1, maxLength: 400 }, relocation: { enum: relocation },
  decision: { enum: decisions },
}, ['id', 'score', 'reason', 'relocation', 'decision']);
scoreSchema.allOf = [
  { if: { properties: { score: { type: 'null' } } }, then: { properties: { decision: { const: 'clarify' } } } },
  { if: { properties: { score: { const: 0 } } }, then: { properties: { decision: { const: 'skip' } } } },
];
const profileFields = ['headline', 'location', 'roleCapabilities', 'seniority', 'skills'];
const preferenceFields = ['roles', 'locations', 'workModes', 'employmentTypes', 'salaryMinimum', 'salaryCurrency',
  'salaryPeriod', 'requiresSponsorship', 'willingToRelocate', 'companySizes', 'companyStages', 'responsibilityModes',
  'directReports', 'travel', 'availability', 'emphasis', 'technologies', 'domains', 'notes'];
const compareText = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const matching = career => career.matching ?? { jobs: {}, scores: {} };
const rankingVersion = career => career.rankingVersion ?? 0;
const currentProfileVersion = matchingProfileVersion;

export async function deleteRankings(store) {
  let result;
  await store.update(state => {
    const career = state.career ??= createCareerState(), saved = matching(career);
    result = { deletedRankings: Object.keys(saved.scores).length, deletedJobs: Object.keys(saved.jobs).length };
    career.rankingVersion = rankingVersion(career) + 1;
    career.matching = { jobs: {}, scores: {} };
  });
  return result;
}

function assertCurrentWindow(jobs, ids) {
  const now = Date.now();
  if (ids.some(id => !recentPublication(jobs[id]?.publishedAt, now)))
    fail('OUTSIDE_PUBLICATION_WINDOW', 'Only jobs published in the past seven days can be selected. Refresh the catalogue and continue with its current IDs.');
}

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
function compact(value, maximum = 600) {
  if (typeof value === 'string') return value.replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[contact omitted]')
    .replace(/https?:\/\/\S+/gi, '[link omitted]').trim().slice(0, maximum);
  if (Array.isArray(value)) return value.map(item => compact(item, maximum));
  return value;
}
function candidateContext(career) {
  const profile = career.profile ?? {};
  const professional = {};
  for (const field of profileFields) if (profile[field] != null && !(Array.isArray(profile[field]) && !profile[field].length)) professional[field] = compact(profile[field]);
  const preferences = {};
  for (const field of preferenceFields) if (own(profile.preferences ?? {}, field))
    preferences[field] = compact(profile.preferences[field], field === 'notes' ? Infinity : 600);
  const cv = Object.values(career.sources ?? {}).filter(source => source.purpose === 'cv' && !source.archived && source.text?.trim())
    .map(source => compact(source.text, Infinity)).join('\n\n');
  const facts = Object.values(career.facts ?? {}).sort(compareFacts)
    .map(({ kind, subject, answer, detail, employer }) => ({ kind, subject: compact(subject), answer: compact(answer),
      ...(detail ? { detail: compact(detail, Infinity) } : {}), ...(employer ? { employer } : {}) }));
  if (!(professional.headline?.trim() || professional.roleCapabilities?.length) || (!cv && !facts.length))
    fail('PROFILE_INCOMPLETE', 'Save a professional headline or roleCapabilities, and import a CV with career_source_import or save career facts with career_facts_save, before matching.');
  return { ...professional, ...(cv ? { cv } : {}), facts, preferences };
}
function currentAssessment(row, profileVersion) {
  return row?.profileVersion === profileVersion && typeof row.profileVersion === 'string' &&
    row.assessmentVersion === ASSESSMENT_VERSION && decisions.includes(row.decision) &&
    (row.score === null ? row.decision === 'clarify' :
      Number.isInteger(row.score) && row.score >= 0 && row.score <= 100 && (row.score !== 0 || row.decision === 'skip'));
}

function counts(jobs, scores, profileVersion) {
  let scored = 0, unavailable = 0, reviewed = 0, needsReview = 0;
  for (const row of Object.values(scores)) {
    if (row.score === null) unavailable++;
    else scored++;
    if (currentAssessment(row, profileVersion)) reviewed++;
    else needsReview++;
  }
  return { scored, pending: Object.keys(jobs).filter(id => !own(scores, id)).length, unavailable, reviewed, needsReview };
}

function matchStatus(assessment, willingToRelocate) {
  if (assessment.score === null) return 'unavailable';
  if (assessment.score === 0) return 'zero_fit';
  if (assessment.relocation === 'not_required') return 'eligible';
  if (assessment.relocation === 'required') {
    if (willingToRelocate === true) return 'requires_relocation';
    if (willingToRelocate === false) return 'incompatible_location';
  }
  return 'needs_location_confirmation';
}

const matchPriority = {
  eligible: 0, requires_relocation: 0, needs_location_confirmation: 1,
  incompatible_location: 2, zero_fit: 3, unavailable: 4,
};

function rankedRows(saved, preferences, profileVersion) {
  const willingToRelocate = preferences?.willingToRelocate;
  const rows = Object.entries(saved.scores).map(([id, assessment]) => {
    const job = saved.jobs[id] ?? {};
    const { profileVersion: _version, assessmentVersion: _policy, ...visibleAssessment } = assessment;
    return { title: null, company: null, publishedAt: null, applyUrl: null,
      ...job, ...visibleAssessment, id, decision: decisions.includes(assessment.decision) ? assessment.decision : null,
      reviewStatus: currentAssessment(assessment, profileVersion) ? 'current' : 'needs_review',
      ...displayTerms(job), salaryEligibility: salaryEligibility(preferences, job.salary),
      matchStatus: matchStatus(assessment, willingToRelocate) };
  });
  const date = value => Number.isFinite(Date.parse(value)) ? Date.parse(value) : -Infinity;
  rows.sort((a, b) => matchPriority[a.matchStatus] - matchPriority[b.matchStatus] ||
    (b.score ?? 0) - (a.score ?? 0) ||
    (date(a.publishedAt) === date(b.publishedAt) ? 0 : date(a.publishedAt) > date(b.publishedAt) ? -1 : 1) ||
    compareText(a.id, b.id));
  return rows;
}

function escapedCSV(value) {
  let text = value == null ? '' : String(value);
  // Quoting alone does not stop spreadsheets from evaluating formulas.
  if (/^[\s\u0000-\u001f]*[=+\-@]|^[\t\r\n]/u.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

function rankingCSV(rows) {
  const columns = ['id', 'title', 'company', 'score', 'publishedAt', 'salaryMinimum', 'salaryMaximum',
    'salaryStated', 'salaryCurrency', 'salaryPeriod', 'city', 'location', 'workMode', 'relocation', 'matchStatus',
    'decision', 'reviewStatus', 'reason', 'applyUrl'];
  return Buffer.from([columns, ...rows.map(row => [row.id, row.title, row.company, row.score, row.publishedAt,
    row.salary?.minimum, row.salary?.maximum, row.salary?.stated, row.salary?.currency, row.salary?.period,
    row.city, row.location, row.workMode, row.relocation, row.matchStatus, row.decision, row.reviewStatus, row.reason, row.applyUrl])]
    .map(row => row.map(escapedCSV).join(',')).join('\r\n') + '\r\n', 'utf8');
}

export function createMatchingTools({ store, platform, exportDocument }) {
  return [
    {
      name: 'career_rankings_delete',
      description: 'Delete local saved job rankings and the cached job list only. Keep profile, preferences, source CVs, career facts, application drafts and account data. Does not run a model or fetch jobs.',
      inputSchema: object({}), readOnly: false,
      async invoke(args = {}) { assertObject(args, []); return deleteRankings(store); },
    },
    {
      name: 'career_match_jobs',
      description: 'Get candidate context and only jobs published in the past seven days. For an ordinary request to reassess, rerank or start over, automatically use refresh:true: delete old job rankings/cache and assess the fresh weekly catalogue, without asking the user for flags or instructions. Status and resume requests must not reset. profileVersion is an opaque ranking-context token returned here, not career_profile_read.evidenceRevision. Use it for score saves. Infer routine competencies from actual scope and enforce the saved salary floor. No model runs here.',
      inputSchema: object({ refresh: { type: 'boolean' } }), readOnly: false,
      async invoke(args = {}) {
        assertObject(args, ['refresh']);
        if (args.refresh !== undefined && typeof args.refresh !== 'boolean') fail('INVALID_INPUT', 'refresh must be a boolean.');
        candidateContext(readCareer(store));
        if (args.refresh) await deleteRankings(store);
        const fetchVersion = rankingVersion(readCareer(store));
        const catalogue = await platform('matching_catalogue', {});
        if (!Array.isArray(catalogue?.jobs) || catalogue.total !== catalogue.jobs.length ||
            new Set(catalogue.jobs.map(job => job?.id)).size !== catalogue.jobs.length || catalogue.jobs.some(job =>
              !job || typeof job.id !== 'string' || !job.id.startsWith('node:') || typeof job.title !== 'string' ||
              typeof job.company !== 'string' || !Number.isFinite(Date.parse(job.publishedAt))))
          fail('INVALID_CATALOGUE', 'The platform returned an incomplete catalogue. No new rankings were saved; request the catalogue again.');
        const window = publicationWindow();
        const jobs = catalogue.jobs.filter(job => recentPublication(job.publishedAt, Date.parse(window.until))).map(job => {
          const { id, title, company, publishedAt, applyUrl } = job;
          return { id, title, company, publishedAt, ...(typeof applyUrl === 'string' ? { applyUrl } : {}), ...displayTerms(job) };
        });
        let result;
        await store.update(state => {
          const career = state.career ??= createCareerState();
          const candidate = candidateContext(career);
          if (rankingVersion(career) !== fetchVersion)
            fail('RANKINGS_CHANGED', 'Rankings were deleted while the catalogue was loading. Request the current catalogue; discarded results were not restored.');
          const previous = career.matching;
          const currentJobs = Object.fromEntries(jobs.map(job => [job.id, job]));
          const scores = Object.fromEntries(Object.entries(previous?.scores ?? {}).filter(([id]) => own(currentJobs, id)));
          const saved = career.matching = { jobs: currentJobs, scores };
          const profileVersion = matchingProfileVersion(career);
          result = { candidate, profileVersion, evidenceRevision: career.evidenceRevision ?? 0,
            assessmentVersion: ASSESSMENT_VERSION, publicationWindow: window,
            assessmentPolicy: { competencies: COMPETENCY_POLICY, salary: SALARY_POLICY },
            jobIds: Object.keys(currentJobs).filter(id => !currentAssessment(saved.scores[id], profileVersion)),
            total: jobs.length, ...counts(saved.jobs, saved.scores, profileVersion), batchSize: 10, workers: 8 };
        });
        return result;
      },
    },
    {
      name: 'career_match_batch',
      description: 'Fetch up to ten complete original ads and company facts, updating local display terms only. Apply the current assessmentPolicy from career_match_jobs: assess actual responsibility and transferable routine competencies, not missing keyword-level facets. Reserve clarify for material unresolved specialties, credentials, legal eligibility or decisive scope. Enforce the saved salary floor against comparable stated pay. Preserve the active target, exceptions, exclusions, independent location classification and full-ad reasoning. Follow remainingIds and unavailableIds; scripts transport data, never generate judgments.',
      inputSchema: object({ ids: { type: 'array', items: idSchema, minItems: 1, maxItems: 10, uniqueItems: true } }, ['ids']), readOnly: false,
      async invoke(args = {}) {
        assertObject(args, ['ids'], ['ids']);
        assertIds(args.ids);
        const before = readCareer(store), fetchVersion = rankingVersion(before), saved = matching(before);
        assertKnown(saved.jobs, args.ids);
        assertCurrentWindow(saved.jobs, args.ids);
        const result = await platform('matching_jobs', { ids: args.ids });
        if (!Array.isArray(result?.jobs) || !Array.isArray(result.remainingIds) || !Array.isArray(result.unavailableIds))
          fail('INVALID_BATCH', 'The platform did not report job availability. Retry career_match_batch; saved scores are unchanged.');
        const covered = [...result.jobs.map(job => job?.id), ...result.remainingIds, ...result.unavailableIds];
        if (covered.length !== args.ids.length || new Set(covered).size !== covered.length || covered.some(id => !args.ids.includes(id)))
          fail('INVALID_BATCH', 'The platform response did not account for every requested job. Retry career_match_batch.');
        if (result.jobs.length) await store.update(state => {
          if (rankingVersion(state.career) !== fetchVersion)
            fail('RANKINGS_CHANGED', 'Rankings were deleted while job details were loading. Discarded jobs were not restored.');
          const saved = matching(state.career ?? {});
          for (const job of result.jobs) {
            const metadata = saved.jobs[job.id] ??= { id: job.id, title: null, company: null, publishedAt: null, applyUrl: null };
            for (const field of ['title', 'publishedAt', 'applyUrl'])
              if (typeof job[field] === 'string') metadata[field] = job[field];
            const company = typeof job.company === 'string' ? job.company : job.company?.name;
            if (typeof company === 'string') metadata.company = company;
            Object.assign(metadata, displayTerms(job));
          }
        });
        return result;
      },
    },
    {
      name: 'career_match_save',
      description: 'Save up to ten model-authored full-ad judgments with profileVersion from career_match_jobs. The current assessmentVersion is recorded automatically; old judgments need genuine reranking, not retagging. Infer ordinary duties from demonstrated scope; do not manufacture granular clarification gates. Keep material specialist gaps honest. Known comparable stated pay below salaryMinimum requires skip and score 0; missing pay alone is not rejection. No score threshold, forced grade, formula, quota or title baseline. Changed preferences reject stale batches with PROFILE_CHANGED.',
      inputSchema: object({
        profileVersion: { type: 'string', pattern: '^[0-9]+:[0-9]+$', maxLength: 80 },
        scores: { type: 'array', items: scoreSchema, minItems: 1, maxItems: 10 },
      }, ['profileVersion', 'scores']), readOnly: false,
      async invoke(args = {}) {
        assertObject(args, ['profileVersion', 'scores'], ['profileVersion', 'scores']);
        if (typeof args.profileVersion !== 'string' || !/^[0-9]+:[0-9]+$/.test(args.profileVersion))
          fail('INVALID_INPUT', 'Use profileVersion from the current career_match_jobs context.');
        if (!Array.isArray(args.scores)) fail('INVALID_INPUT', 'Provide one to ten score rows.');
        for (const row of args.scores) {
          assertObject(row, ['id', 'score', 'reason', 'relocation', 'decision'], ['id', 'score', 'reason', 'relocation', 'decision']);
          if (!(row.score === null || Number.isInteger(row.score) && row.score >= 0 && row.score <= 100) ||
              typeof row.reason !== 'string' || !row.reason.trim() || row.reason.length > 400 || !relocation.includes(row.relocation) ||
              !decisions.includes(row.decision) || row.score === null && row.decision !== 'clarify' ||
              row.score === 0 && row.decision !== 'skip')
            fail('INVALID_INPUT', 'Each row needs an integer score 0–100 or null, a reason up to 400 characters, relocation required/not_required/unclear and decision recommend/clarify/skip. Null requires clarify; genuine zero fit requires skip.');
        }
        assertIds(args.scores.map(row => row.id));
        await store.update(state => {
          const career = state.career ??= createCareerState();
          if (args.profileVersion !== currentProfileVersion(career))
            fail('PROFILE_CHANGED', 'Candidate data or the ranking context changed. Call career_match_jobs and reassess affected jobs using its current profileVersion; do not reuse a token from before deleting rankings.');
          const saved = matching(career);
          assertKnown({ ...saved.jobs, ...saved.scores }, args.scores.map(row => row.id));
          assertCurrentWindow(saved.jobs, args.scores.map(row => row.id));
          for (const row of args.scores) {
            const pay = salaryEligibility(career.profile?.preferences, saved.jobs[row.id]?.salary);
            if (row.score !== null && pay.status === 'below_minimum' && (row.decision !== 'skip' || row.score !== 0))
              fail('SALARY_BELOW_MINIMUM', `${row.id}: stated pay ceiling ${pay.upperBound} ${pay.currency}/${pay.period} is below the minimum ${pay.minimum}. Record skip with score 0, not a recommendation or clarification.`);
          }
          const scoredAt = new Date().toISOString();
          for (const row of args.scores) saved.scores[row.id] = { ...row, profileVersion: args.profileVersion, assessmentVersion: ASSESSMENT_VERSION, scoredAt };
        });
        return { saved: args.scores.length };
      },
    },
    {
      name: 'career_matches',
      description: 'Read the complete local assessment archive, NOT a recommendation list. Includes skip, clarify, legacy/stale, older, move-required, zero, unavailable and missing-metadata rows without network, inference or paid membership. decision is the saved model judgment; reviewStatus current means bound to current evidence, not proof of assessment quality. needs_review rows cannot be recommendations. Existing location-group ordering is archive organization only: eligible means location-compatible, not career-suitable. Scores are unchanged, ordered within location groups by score/date descending then ID. Use career_recommendations for current suitable next-application candidates; it may honestly be empty. Do not pad it from this archive or trigger full rescoring just to show saved results. Follow nextOffset until null; total counts all saved assessments. Use career_matches_export for all-row CSV. Display Published (JobStash), salary currency/period/bounds, city/location, work mode, role/company, score, decision, reviewStatus, relocation, matchStatus, reason and link. Use publishedAt, not scoredAt/current date; unknown metadata is Not stated. Saved rows do not prove vacancies remain open.',
      inputSchema: object({ limit: { type: 'integer', minimum: 1, maximum: 100 }, offset: { type: 'integer', minimum: 0 } }), readOnly: true,
      async invoke(args = {}) {
        assertObject(args, ['limit', 'offset']);
        const { limit = 25, offset = 0 } = args;
        if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger(offset) || offset < 0)
          fail('INVALID_INPUT', 'Use limit 1–100 and a nonnegative integer offset.');
        const career = readCareer(store), saved = matching(career);
        const profileVersion = currentProfileVersion(career);
        const rows = rankedRows(saved, career.profile?.preferences, profileVersion);
        const matches = rows.slice(offset, offset + limit);
        return { view: 'assessment_archive', matches, total: rows.length, assessmentVersion: ASSESSMENT_VERSION,
          nextOffset: offset + matches.length < rows.length ? offset + matches.length : null,
          ...counts(saved.jobs, saved.scores, profileVersion) };
      },
    },
    {
      name: 'career_recommendations',
      description: 'Read recommendations assessed under the current profile and policy, with compatible location and no comparable stated pay below salaryMinimum. Unknown salary alone does not exclude; do not claim non-comparable pay meets the floor. Old judgments are needs_review until the host reranks them. No inference, network or payment. Use career_matches for the full archive. When needsReview is nonzero, an empty current list does not mean the candidate has no suitable jobs.',
      inputSchema: object({ limit: { type: 'integer', minimum: 1, maximum: 100 }, offset: { type: 'integer', minimum: 0 } }), readOnly: true,
      async invoke(args = {}) {
        assertObject(args, ['limit', 'offset']);
        const { limit = 25, offset = 0 } = args;
        if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger(offset) || offset < 0)
          fail('INVALID_INPUT', 'Use limit 1–100 and a nonnegative integer offset.');
        const career = readCareer(store), saved = matching(career), profileVersion = currentProfileVersion(career);
        const rows = rankedRows(saved, career.profile?.preferences, profileVersion)
          .filter(row => row.reviewStatus === 'current' && row.decision === 'recommend' &&
            recentPublication(row.publishedAt) && row.salaryEligibility.status !== 'below_minimum' &&
            ['eligible', 'requires_relocation'].includes(row.matchStatus));
        const recommendations = rows.slice(offset, offset + limit);
        return { recommendations, total: rows.length, assessmentVersion: ASSESSMENT_VERSION,
          nextOffset: offset + recommendations.length < rows.length ? offset + recommendations.length : null,
          ...counts(saved.jobs, saved.scores, profileVersion) };
      },
    },
    {
      name: 'career_matches_export',
      description: 'Export the COMPLETE ASSESSMENT ARCHIVE, not a recommendation list, as one local UTF-8 CSV in the same archive order as career_matches. Includes decision, reviewStatus, matchStatus and unchanged scores for every skip, clarify, legacy/stale, zero, move-required, older, missing-metadata and unavailable row. No internal row versions, network, inference, payment or score changes. Empty arguments only; no filters or page limits.',
      inputSchema: object({}), readOnly: false,
      async invoke(args = {}) {
        assertObject(args, []);
        if (typeof exportDocument !== 'function') fail('EXPORT_UNAVAILABLE', 'Local document export is unavailable. Read all career_matches pages instead.');
        const career = readCareer(store), saved = matching(career);
        const profileVersion = currentProfileVersion(career);
        const rows = rankedRows(saved, career.profile?.preferences, profileVersion);
        const coverage = counts(saved.jobs, saved.scores, profileVersion);
        const exported = await exportDocument({ bytes: rankingCSV(rows), mediaType: 'text/csv' });
        return { view: 'assessment_archive', total: rows.length, ...coverage, export: { ...exported, mediaType: 'text/csv' } };
      },
    },
  ];
}
