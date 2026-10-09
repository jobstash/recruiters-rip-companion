import { createCareerState, fail, readCareer } from './state.mjs';

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
  const profile = career.profile ?? {}, sources = career.sources ?? {}, facts = career.facts ?? {};
  const current = fact => fact?.status === 'active' && (fact.source?.kind !== 'document' ||
    Boolean(sources[fact.source.sourceId] && !sources[fact.source.sourceId].archived));
  const fieldCurrent = field => {
    const source = profile.fieldSources?.[field];
    return source?.kind !== 'fact' || current(facts[source.factId]);
  };
  const professional = {};
  for (const field of profileFields) if (fieldCurrent(field) && profile[field] != null) professional[field] = compact(profile[field]);
  const preferences = {};
  for (const field of preferenceFields) if (own(profile.preferences ?? {}, field) && fieldCurrent(`preferences.${field}`))
    preferences[field] = compact(profile.preferences[field], field === 'notes' ? Infinity : 600);
  const seen = new Set();
  const summaries = Object.values(facts).filter(fact => current(fact) &&
    ['experience', 'education', 'achievement', 'skill'].includes(fact.kind) && typeof fact.statement === 'string' && fact.statement.trim())
    .sort((a, b) => compareText(a.startDate || '9999', b.startDate || '9999') || compareText(a.endDate || '9999', b.endDate || '9999'))
    .flatMap(fact => {
      const statement = compact(fact.statement);
      const key = JSON.stringify([statement, fact.employer, fact.role, fact.startDate, fact.endDate]);
      if (seen.has(key)) return [];
      seen.add(key);
      const summary = { kind: fact.kind, statement };
      for (const field of ['employer', 'role', 'startDate', 'endDate']) if (fact[field]) summary[field] = compact(fact[field], 300);
      return [summary];
    });
  const hasRole = Boolean(professional.headline?.trim() || professional.roleCapabilities?.length);
  if (!hasRole || !summaries.some(fact => ['experience', 'education', 'achievement'].includes(fact.kind)))
    fail('PROFILE_INCOMPLETE', 'Save a professional headline or roleCapabilities and current experience, education or achievement facts before matching. Use career_profile_update and career_facts_add, or onboarding_commit after reading your saved CV.');
  return { ...professional, facts: summaries, preferences };
}
function currentAssessment(row, profileVersion) {
  return row?.profileVersion === profileVersion && Number.isSafeInteger(row.profileVersion) &&
    decisions.includes(row.decision) &&
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

function rankedRows(saved, willingToRelocate, profileVersion) {
  const rows = Object.entries(saved.scores).map(([id, assessment]) => {
    const job = saved.jobs[id] ?? {};
    const { profileVersion: _version, ...visibleAssessment } = assessment;
    return { title: null, company: null, publishedAt: null, applyUrl: null,
      ...job, ...visibleAssessment, id, decision: decisions.includes(assessment.decision) ? assessment.decision : null,
      reviewStatus: currentAssessment(assessment, profileVersion) ? 'current' : 'needs_review',
      ...displayTerms(job), matchStatus: matchStatus(assessment, willingToRelocate) };
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
      name: 'career_match_jobs',
      description: 'Read current professional context, complete preference notes, profileVersion and recent catalogue IDs. By default return unseen jobs plus saved assessments needing review, including those outside the discovery window; refresh includes every saved ID for deliberate reassessment. Pass profileVersion once per save batch. Use up to eight native subscription workers and batches of ten, each with the ACTIVE target, complete notes, demonstrated scope, scoped exceptions, hard exclusions and server assessment rules. Suitability comes before score: decide recommend, clarify or skip using full ads and evidence, never keyword familiarity alone. Comparable-or-higher sustained responsibility is the default; an explicit narrower/transition search replaces it only within its chosen scope, while also-open-to exceptions only expand scope. Inspect the first batch and independently review leading full ads before application/CV selection. Reconcile analogous assessments using evidence, not formulas or title similarity. Location never reduces fit. Use bounded corrections rather than automatic full-catalogue rescoring; saved rankings do not require this network call. No model runs here.',
      inputSchema: object({ refresh: { type: 'boolean' } }), readOnly: false,
      async invoke(args = {}) {
        assertObject(args, ['refresh']);
        if (args.refresh !== undefined && typeof args.refresh !== 'boolean') fail('INVALID_INPUT', 'refresh must be a boolean.');
        candidateContext(readCareer(store));
        const catalogue = await platform('matching_catalogue', {});
        if (!Array.isArray(catalogue?.jobs) || catalogue.total !== catalogue.jobs.length ||
            new Set(catalogue.jobs.map(job => job?.id)).size !== catalogue.jobs.length || catalogue.jobs.some(job =>
              !job || typeof job.id !== 'string' || !job.id.startsWith('node:') || typeof job.title !== 'string' ||
              typeof job.company !== 'string' || !Number.isFinite(Date.parse(job.publishedAt))))
          fail('INVALID_CATALOGUE', 'The platform returned an incomplete job catalogue. Retry career_match_jobs; saved scores are unchanged.');
        const jobs = catalogue.jobs.map(job => {
          const { id, title, company, publishedAt, applyUrl } = job;
          return { id, title, company, publishedAt, ...(typeof applyUrl === 'string' ? { applyUrl } : {}), ...displayTerms(job) };
        });
        let result;
        await store.update(state => {
          const career = state.career ??= createCareerState();
          const candidate = candidateContext(career);
          const saved = career.matching ??= { jobs: {}, scores: {} };
          const currentJobs = Object.fromEntries(jobs.map(job => [job.id, job]));
          const profileVersion = career.evidenceRevision ?? 0;
          const discoveryJobs = { ...currentJobs };
          for (const [id, assessment] of Object.entries(saved.scores))
            if (!own(discoveryJobs, id) && (args.refresh || !currentAssessment(assessment, profileVersion)))
              discoveryJobs[id] = saved.jobs[id] ?? null;
          const coverage = counts(discoveryJobs, Object.fromEntries(
            Object.entries(saved.scores).filter(([id]) => own(discoveryJobs, id))), profileVersion);
          for (const [id, job] of Object.entries(saved.jobs))
            if (own(saved.scores, id) && !own(currentJobs, id)) currentJobs[id] = job;
          saved.jobs = currentJobs;
          result = { candidate, profileVersion,
            jobIds: Object.keys(discoveryJobs).filter(id => args.refresh || !currentAssessment(saved.scores[id], profileVersion)),
            total: Object.keys(discoveryJobs).length, ...coverage, batchSize: 10, workers: 8 };
        });
        return result;
      },
    },
    {
      name: 'career_match_batch',
      description: 'Fetch up to ten complete original ads and company facts; update only local display terms. Assess each full ad and closing restrictions against the ACTIVE search target and demonstrated scope, autonomy, decisions, ownership and impact. Explicit choice of a narrower/transition search replaces the usual management/comparable-up target within scope; assess that choice without a prior-track penalty. Also-open-to exceptions expand scope, not replace it; neither globally rewrites preferences. Otherwise comparable-or-higher responsibility is the default and narrow step-downs need explicit search opt-in, not technology novelty, travel, salary or scarce matches. High-impact IC exceptions to an active management path need comparable-or-greater authority/impact, not a management label. Vague lead/own/build/mentor/founding/staff/CTO-of-account wording does not establish reports, managing managers, hiring authority or promised promotion. Missing scope is unknown, earns no positive leadership credit and may require specific employer clarification outside CV questions. Assess essential employer capabilities independently; do not invent promotion qualifications. Conditional remote-country eligibility stays unclear despite broad headings. Determine hard industry exclusions semantically from actual business and explicit constraints, not keywords: ordinary gaming differs from gambling/NFTs; incidental or negated mentions do not disqualify. Confirmed hard non-location exclusions require score 0 with grounded reason; save but do not recommend. Scripts may move data, never assess it. Follow remainingIds; unavailableIds identifies missing/offline jobs.',
      inputSchema: object({ ids: { type: 'array', items: idSchema, minItems: 1, maxItems: 10, uniqueItems: true } }, ['ids']), readOnly: false,
      async invoke(args = {}) {
        assertObject(args, ['ids'], ['ids']);
        assertIds(args.ids);
        const saved = matching(readCareer(store));
        assertKnown({ ...saved.jobs, ...saved.scores }, args.ids);
        const result = await platform('matching_jobs', { ids: args.ids });
        if (!Array.isArray(result?.jobs) || !Array.isArray(result.remainingIds) || !Array.isArray(result.unavailableIds))
          fail('INVALID_BATCH', 'The platform did not report job availability. Retry career_match_batch; saved scores are unchanged.');
        const covered = [...result.jobs.map(job => job?.id), ...result.remainingIds, ...result.unavailableIds];
        if (covered.length !== args.ids.length || new Set(covered).size !== covered.length || covered.some(id => !args.ids.includes(id)))
          fail('INVALID_BATCH', 'The platform response did not account for every requested job. Retry career_match_batch.');
        if (result.jobs.length) await store.update(state => {
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
      description: 'Save up to ten model-authored full-ad assessments with one profileVersion from career_match_jobs, or the same numeric evidenceRevision from local career_profile_read. Evidence/preference changes reject the entire outdated batch with PROFILE_CHANGED; reread context and reassess only affected jobs. Each row requires decision recommend|clarify|skip: recommend means evidenced suitability for the ACTIVE career target, essential qualifications and non-location exclusions with no material unresolved obstacle; decisive unknown essentials/scope mean clarify; demonstrated mismatch or exclusion means skip. Location remains separate and never lowers score or changes this decision. Use an evidence-supported integer 0–100 overall fit, not keyword capability or title formulas. Required experience/depth is not skill-list familiarity; leadership cannot erase missing essential specialty. Every integer is valid; fully evidenced fit can be 100 without inventing deficits or future-interview uncertainty. Zero means genuine no-fit/hard non-location exclusion and requires skip; null is only for unavailable originals and requires clarify. No thresholds, bonuses, fixed caps or forced distributions turn a job into a recommendation. Scores and decisions must be coherent. Explicit narrower/transition targets replace prior direction within their scope; also-open-to exceptions merely expand scope. Otherwise maintain comparable-or-higher responsibility; senior IC exceptions need substantive authority. Vague leadership is unknown. Save all assessments; validation and persistence do not audit reasoning.',
      inputSchema: object({
        profileVersion: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
        scores: { type: 'array', items: scoreSchema, minItems: 1, maxItems: 10 },
      }, ['profileVersion', 'scores']), readOnly: false,
      async invoke(args = {}) {
        assertObject(args, ['profileVersion', 'scores'], ['profileVersion', 'scores']);
        if (!Number.isSafeInteger(args.profileVersion) || args.profileVersion < 0)
          fail('INVALID_INPUT', 'Provide profileVersion from career_match_jobs or evidenceRevision from career_profile_read.');
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
          if (args.profileVersion !== (career.evidenceRevision ?? 0))
            fail('PROFILE_CHANGED', 'Candidate evidence or preferences changed. Read career_profile_read and current facts, or career_match_jobs, reassess these jobs and save with the current profileVersion. Existing assessments are unchanged.');
          const saved = matching(career);
          assertKnown({ ...saved.jobs, ...saved.scores }, args.scores.map(row => row.id));
          const scoredAt = new Date().toISOString();
          for (const row of args.scores) saved.scores[row.id] = { ...row, profileVersion: args.profileVersion, scoredAt };
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
        const profileVersion = career.evidenceRevision ?? 0;
        const rows = rankedRows(saved, career.profile?.preferences?.willingToRelocate, profileVersion);
        const matches = rows.slice(offset, offset + limit);
        return { view: 'assessment_archive', matches, total: rows.length,
          nextOffset: offset + matches.length < rows.length ? offset + matches.length : null,
          ...counts(saved.jobs, saved.scores, profileVersion) };
      },
    },
    {
      name: 'career_recommendations',
      description: 'Read only current model-authored recommend decisions with compatible location or explicit relocation consent. No network, inference or payment. Ordered by unchanged score/date descending then ID. Never pads with clarify, skip, stale, legacy, zero or unavailable assessments; an empty list is valid. Counts distinguish saved coverage from assessments needing review. Use career_matches and career_matches_export for the complete assessment archive. Before next-application or CV selection, review the complete original ad and current evidence; a saved decision does not prove assessment quality.',
      inputSchema: object({ limit: { type: 'integer', minimum: 1, maximum: 100 }, offset: { type: 'integer', minimum: 0 } }), readOnly: true,
      async invoke(args = {}) {
        assertObject(args, ['limit', 'offset']);
        const { limit = 25, offset = 0 } = args;
        if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger(offset) || offset < 0)
          fail('INVALID_INPUT', 'Use limit 1–100 and a nonnegative integer offset.');
        const career = readCareer(store), saved = matching(career), profileVersion = career.evidenceRevision ?? 0;
        const rows = rankedRows(saved, career.profile?.preferences?.willingToRelocate, profileVersion)
          .filter(row => row.reviewStatus === 'current' && row.decision === 'recommend' &&
            ['eligible', 'requires_relocation'].includes(row.matchStatus));
        const recommendations = rows.slice(offset, offset + limit);
        return { recommendations, total: rows.length,
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
        const profileVersion = career.evidenceRevision ?? 0;
        const rows = rankedRows(saved, career.profile?.preferences?.willingToRelocate, profileVersion);
        const coverage = counts(saved.jobs, saved.scores, profileVersion);
        const exported = await exportDocument({ bytes: rankingCSV(rows), mediaType: 'text/csv' });
        return { view: 'assessment_archive', total: rows.length, ...coverage, export: { ...exported, mediaType: 'text/csv' } };
      },
    },
  ];
}
