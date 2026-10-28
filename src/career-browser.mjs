import { createRequire } from 'node:module';
import { cvHeading } from './mcp/application-tools.mjs';
import { renderableCv } from './mcp/cv-quality.mjs';
import { createMatchingTools } from './mcp/matching-tools.mjs';
import { fail, readCareer } from './mcp/state.mjs';
import { currentPrescanRow, prescanInclusion } from './prescan/state.mjs';
import { DEFAULT_PUBLICATION_RANGE, publicationWindowForRange } from './prescan/publication-range.mjs';
import { localJobMetadata } from './mcp/job-tools.mjs';
import { blockedIds, listBlocks } from './mcp/blocklist.mjs';
import { employmentHistory } from './employment-browser.mjs';
import { preferenceItems } from './preferences-browser.mjs';

const kinds = ['sources', 'facts', 'preferences', 'career', 'jobs', 'applications', 'blocks'];
const forbidden = new Set(['__proto__', 'prototype', 'constructor']);
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (value, key) => record(value) && Object.hasOwn(value, key);
const text = (value, fallback = 'Not saved') => typeof value === 'string' && value.length ? value : fallback;
const scalar = value => typeof value === 'string' ? value : typeof value === 'number' || typeof value === 'boolean' ? String(value) : 'Not saved';
const section = (heading, value) => ({ heading, text: text(value) });
// Field sections let the reader present labelled values instead of "Label: value" prose.
// A third row element `numeric` marks scores that the reader sets in Geist Mono.
const fields = (heading, rows, empty) => {
  const values = rows.filter(([, value]) => value !== null && value !== undefined && value !== '')
    .map(([label, value, kind]) => ({ label, value: scalar(value), ...(kind === 'numeric' ? { numeric: true } : {}) }));
  return values.length ? { heading, fields: values } : { heading, text: empty };
};
// Chart sections carry integer 0–100 values the reader draws as horizontal bars; missing values are skipped.
const chart = (heading, rows, empty) => {
  const values = rows.filter(([, value]) => Number.isInteger(value) && value >= 0 && value <= 100).map(([label, value]) => ({ label, value }));
  return values.length ? { heading, chart: values } : { heading, text: empty };
};
const amount = value => Number.isFinite(value) ? value.toLocaleString('en-GB') : null;
const readable = value => typeof value === 'string' && value ? value === 'cv' ? 'CV' : value.replaceAll('_', ' ').replace(/^./, letter => letter.toUpperCase()) : undefined;
const entries = value => record(value) ? Object.entries(value).filter(([id, item]) => !forbidden.has(id) && record(item)) : [];
const lookup = (value, id) => !forbidden.has(id) && own(value, id) && record(value[id]) ? value[id] : null;
const displayDate = value => Number.isFinite(Date.parse(value)) ? new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeZone: 'UTC' }).format(new Date(value)) : undefined;

function validate(args, fields) {
  if (!record(args) || ![Object.prototype, null].includes(Object.getPrototypeOf(args)) ||
      Reflect.ownKeys(args).some(key => !fields.includes(key)) || !own(args, 'kind') || !kinds.includes(args.kind)) {
    fail('INVALID_INPUT', `Provide kind (${kinds.join(', ')}) and only ${fields.join(', ')}.`);
  }
}

function sourceDetail(source) {
  return { title: text(source.name, 'Untitled source'), sections: [
    fields(source.purpose === 'cv' ? 'CV' : 'Source', [
      ['Status', source.archived ? 'Archived' : 'Current'], ['Purpose', source.purpose === 'cv' ? undefined : readable(source.purpose)],
      ['Added', displayDate(source.createdAt)],
    ], 'No source details saved.'),
    section('Text', text(source.text, 'No extracted text is saved for this source.')),
  ] };
}

function factDetail(fact, career) {
  const applicationLabel = id => {
    const app = lookup(career.applications, id);
    return app ? applicationTitle(app) : undefined;
  };
  return { title: text(fact.subject, 'Untitled fact'), sections: [
    section('Explanation', fact.detail?.trim() ? fact.detail : fact.answer),
    fields('Details', [['Level', fact.answer], ['Question', fact.question], ['Context', fact.context],
      ['Application', applicationLabel(fact.applicationId)], ['Employer', fact.employer]], 'No details saved.'),
    ...(Array.isArray(fact.followUps) ? fact.followUps.map(exchange =>
      fields('Follow-up', [['Question', exchange.question], ['Answer', exchange.answer], ['Context', exchange.context],
        ['Application', applicationLabel(exchange.applicationId)]], 'No exchange saved.')) : []),
  ] };
}

let renderCv;
function draftSections(kind, draft, career, historical = false) {
  const label = `${historical ? 'Earlier ' : ''}${kind === 'cv' ? 'CV' : 'Cover letter'}`;
  if (!record(draft)) return [section(label, `No ${kind === 'cv' ? 'CV' : 'cover letter'} draft is saved.`)];
  const date = displayDate(draft.createdAt);
  const heading = historical && date ? `${label} — ${date}` : label;
  let wording = '';
  if (kind === 'cv' && record(draft.document)) {
    // Use the same profile header and reading order as exported CVs.
    renderCv ??= createRequire(import.meta.url)('./generated/document-engine.cjs').renderCareerCvText;
    wording = renderCv({ document: renderableCv(draft.document), heading: cvHeading(career.profile ?? {}) });
  } else if (kind === 'cover_letter' && Array.isArray(draft.paragraphs)) {
    wording = draft.paragraphs.filter(item => typeof item === 'string').join('\n\n');
  }
  return [section(heading, text(wording, `No ${kind === 'cv' ? 'CV' : 'cover letter'} wording is saved in this draft.`))];
}
function applicationTitle(app) {
  return [text(app.job?.title, ''), text(app.job?.company, '')].filter(Boolean).join(' — ') || 'Untitled application';
}
function applicationDetail(app, career) {
  return { title: applicationTitle(app), sections: [
    fields('Application', [
      ['Company', app.job?.company], ['Location', app.job?.location], ['Job link', app.job?.url],
      ['Created', displayDate(app.createdAt)], ['Updated', displayDate(app.updatedAt)],
    ], 'No application details saved.'),
    ...draftSections('cv', app.cv, career), ...draftSections('cover_letter', app.coverLetter, career),
    ...(Array.isArray(app.cvHistory) ? app.cvHistory.flatMap(draft => draftSections('cv', draft, career, true)) : []),
    ...(Array.isArray(app.coverLetterHistory) ? app.coverLetterHistory.flatMap(draft => draftSections('cover_letter', draft, career, true)) : []),
  ] };
}
const assessmentLabels = {
  recommend: 'Recommended', clarify: 'Needs clarification', skip: 'Not recommended',
  current: 'Reviewed', needs_review: 'Needs reassessment',
  eligible: 'Location compatible', requires_relocation: 'Relocation required',
  needs_location_confirmation: 'Location needs confirmation', incompatible_location: 'Location incompatible',
  excluded: 'Excluded by a gate', unavailable: 'Assessment unavailable',
  required: 'Required', not_required: 'Not required', unclear: 'Unclear',
  below_minimum: 'Below your minimum', range_can_meet_minimum: 'Range can meet your minimum',
  meets_minimum: 'Meets your minimum', not_comparable: 'Cannot compare with your minimum',
  unbounded_range: 'Upper salary bound not stated', not_stated: 'Salary not stated',
};
const assessmentLabel = value => own(assessmentLabels, value) ? assessmentLabels[value] : readable(value);
const blockKinds = { job: 'Job', company: 'Company', category: 'Category' };
const prescanStatuses = {
  unavailable: 'Original advert unavailable', oversize: 'Input exceeds the provider limit', refused: 'Provider declined assessment',
  incompatible_location: 'Location conflict predicted', below_minimum: 'Salary below your minimum',
};
const prescanScore = row => row?.status === 'scored' && Number.isInteger(row.priority) && row.priority >= 0 && row.priority <= 100
  ? row.priority : -1;
const prescanStatus = row => prescanScore(row) >= 0 ? 'Scored' : prescanStatuses[row.status] || 'Not scored';
const prescanLocations = { aligned: 'Compatible', uncertain: 'Not established', conflict: 'Conflict' };
const cardStatuses = new Set(['unavailable', 'refused', 'oversize', 'incompatible_location', 'below_minimum']);
// A saved review with one of these verdicts makes the job ineligible: the card shows the verdict, never a number.
const ineligibleMatches = new Set(['incompatible_location', 'excluded']);
const ineligibleLabel = reviewed => ineligibleMatches.has(reviewed?.matchStatus) ? assessmentLabel(reviewed.matchStatus) : 'Location incompatible';
// A card shows where the job stands: reviewed by an agent (fit), ineligible (a saved verdict instead of a number),
// scored by the pre-filter for the next run (score and whether it is sent), or neither. Fit and pre-filter score are
// different scales and never share a caption.
// An established incompatibility (any saved gate fail, or relocation required against a refusal to relocate) is never a
// candidate and has no switch; a predicted one (pre-scan only) keeps the switch.
function cardStage({ id, reviewed, prescan }, inclusion) {
  const reviewCurrent = reviewed?.reviewStatus === 'current';
  const established = !reviewCurrent && inclusion.established(id);
  const ineligible = reviewCurrent ? ineligibleMatches.has(reviewed.matchStatus) : established;
  const candidate = !reviewCurrent && !established;
  const rank = candidate ? inclusion.rank.get(id) ?? null : null;
  return {
    stage: ineligible ? 'ineligible' : reviewCurrent ? 'reviewed' : rank !== null ? 'prefilter' : 'unscored',
    label: ineligible ? ineligibleLabel(reviewed) : null, established,
    rank, prefilterScore: rank !== null ? prescanScore(prescan) : null,
    included: candidate && inclusion.includedIds.has(id), overridden: candidate && inclusion.overridden(id),
    score: Number.isInteger(reviewed?.overall) ? reviewed.overall : null,
    stale: reviewed ? !reviewCurrent : Boolean(prescan) && prescan.current !== true,
    status: !reviewCurrent && prescan && cardStatuses.has(prescan.status) ? prescan.status : null,
  };
}
const bandLabel = band => typeof band === 'string' && band ? band.replace(/^./, letter => letter.toUpperCase()) : undefined;
const gateLabels = { pass: 'Passes', flag: 'Needs confirmation', fail: 'Fails' };
// Ineligible reviews keep their dimension chart, but the heading says what the number cannot: the job is out.
const fitHeadings = { incompatible_location: 'Fit excluding location — not eligible', excluded: 'Fit — excluded by a gate' };
const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;

const decisionLabels = { recommend: 'Recommended', clarify: 'Needs clarification', skip: 'Not recommended' };
const joinFacts = parts => parts.filter(part => typeof part === 'string' && part).join(' · ');

/** The verdict is the reader's first block: the number that placed the job in the list, the rule it was measured against,
 *  and the agent's reason when one exists. Everything else in the reader is evidence for it. */
function jobVerdict({ reviewed, prescan }, card, minimumScore) {
  const reviewDate = displayDate(reviewed?.scoredAt);
  const staleReview = reviewed && card.stage !== 'reviewed' && Number.isInteger(reviewed.overall)
    ? `Reviewed at ${reviewed.overall} before your profile changed` : null;
  const reason = typeof reviewed?.reason === 'string' && reviewed.reason.trim() ? reviewed.reason : null;
  if (card.stage === 'reviewed') {
    return { kind: 'reviewed', number: card.score, numberLabel: 'Fit',
      headline: decisionLabels[reviewed.decision] ?? 'No saved decision',
      detail: joinFacts([bandLabel(reviewed.band) && `${bandLabel(reviewed.band)} fit`,
        Number.isFinite(reviewed.pairwiseWins) ? `${plural(reviewed.pairwiseWins, 'win')} of ${plural(reviewed.pairwiseCompared, 'comparison')}` : null,
        reviewDate && `Reviewed ${reviewDate}`]),
      reason };
  }
  if (card.stage === 'ineligible') {
    // The label is the whole actionable decision; repeating location, relocation and the saved review prose below it is noise.
    return { kind: 'ineligible', number: null, numberLabel: null, headline: card.label, detail: null, reason: null };
  }
  const included = card.included ? 'Queued for AI review' : 'Skipped';
  const manual = card.overridden ? ' · manual' : '';
  if (card.stage === 'prefilter') {
    const score = prescanScore(prescan);
    return { kind: 'prefilter', number: score, numberLabel: 'Score', headline: included,
      detail: joinFacts([`${score} is ${score >= minimumScore ? 'at or above' : 'below'} the qualifying score ${minimumScore}${manual}`,
        card.stale ? 'scored before your profile changed' : null]),
      reason: staleReview ? joinFacts([staleReview, reason]) : reason };
  }
  return { kind: 'unscored', number: null, numberLabel: null, headline: `${included}${manual}`,
    detail: prescan ? prescanStatuses[prescan.status] ?? 'Not scored' : 'Not scored yet',
    reason: staleReview ? joinFacts([staleReview, reason]) : reason };
}

// Requirements are actionable evidence rows rather than generic labelled fields. Gaps come first, and mandatory
// requirements precede preferred ones within the same evidence state.
const evidenceOrder = { contradicted: 0, missing: 1, transferable: 2, demonstrated: 3 };
const importanceOrder = { essential: 0, preferred: 1 };
function reviewedSections(row) {
  const requirements = Array.isArray(row.requirements)
    ? row.requirements.filter(item => record(item) && typeof item.requirement === 'string' && item.requirement.length) : [];
  const ordered = [...requirements].sort((a, b) => (evidenceOrder[a.evidence] ?? 9) - (evidenceOrder[b.evidence] ?? 9) ||
    (importanceOrder[a.importance] ?? 9) - (importanceOrder[b.importance] ?? 9));
  return [
    ...(record(row.dimensions) || Number.isInteger(row.overall) ? [chart(fitHeadings[row.matchStatus] ?? 'Fit', [
      ['Overall', row.overall], ['Direction', row.dimensions?.direction], ['Capability', row.dimensions?.capability],
      ['Scope', row.dimensions?.scope], ['Preferences', row.dimensions?.preferences],
    ], 'No breakdown saved.')] : []),
    ...(ordered.length ? [{ heading: 'Requirements', requirements: ordered.map(item => ({
      requirement: item.requirement,
      evidence: readable(item.evidence) ?? 'Unrated',
      importance: item.importance === 'essential' ? 'essential' : readable(item.importance)?.toLowerCase() ?? 'unrated',
    })) }] : []),
  ];
}

/** What the user has already done about this job: prepared documents and interview answers, never a claimed submission. */
function applicationSection(career, id) {
  const app = entries(career.applications).map(([, item]) => item).find(item => item.job?.id === id);
  if (!app) return [];
  const answers = entries(career.facts).filter(([, fact]) => fact.applicationId === app.id).length;
  const draft = value => record(value) ? displayDate(value.createdAt) ?? 'Saved' : 'Not drafted';
  return [fields('Your application', [
    ['Prepared', displayDate(app.createdAt)], ['CV draft', draft(app.cv)], ['Cover letter', draft(app.coverLetter)],
    ['Exports', Array.isArray(app.exports) && app.exports.length ? plural(app.exports.length, 'export') : undefined],
    ['Interview answers', answers ? plural(answers, 'answer') : undefined],
  ], 'No application details saved.')];
}

function jobItem({ id, reviewed, prescan, imported, metadata }, inclusion, career) {
  const role = key => imported?.[key] ?? metadata?.[key] ?? reviewed?.[key] ?? prescan?.[key];
  const roleTitle = text(role('title'), '');
  const company = text(role('company'), '');
  const title = [roleTitle, company].filter(Boolean).join(' — ') || 'Job details unavailable';
  const salary = role('salary');
  const range = salary && (amount(salary.stated) ?? [amount(salary.minimum), amount(salary.maximum)].filter(Boolean).join('–'));
  const pay = range ? [salary.currency, range, salary.period && `per ${salary.period}`].filter(Boolean).join(' ') : null;
  const reviewCurrent = reviewed?.reviewStatus === 'current';
  const publishedAt = role('publishedAt');
  const fact = value => typeof value === 'string' && value ? [value] : [];
  // "Remote" as the posted location and "remote" as the work mode are one fact, not two.
  const locationFact = (place, mode) => [place, mode && place?.toLowerCase() !== mode.toLowerCase() ? mode : null]
    .filter(value => typeof value === 'string' && value).join(' · ');
  const facts = [...fact(role('seniority')), ...fact(pay), ...fact(locationFact(role('city') || role('location'), role('workMode'))),
    ...fact(role('commitment')), ...fact(role('classification'))];
  const logoUrl = typeof role('logoUrl') === 'string' && /^https:\/\//.test(role('logoUrl')) ? role('logoUrl') : null;
  const card = {
    title: roleTitle || title, company: company || null, logoUrl,
    publishedAt: typeof publishedAt === 'string' && Number.isFinite(Date.parse(publishedAt)) ? publishedAt : null,
    facts, ...cardStage({ id, reviewed, prescan }, inclusion),
  };
  // What the reader can offer to block besides the job itself.
  const block = { company: company || null, category: text(role('classification'), '') || null };
  const applyUrl = typeof role('applyUrl') === 'string' && /^https?:\/\//.test(role('applyUrl')) ? role('applyUrl') : null;
  const header = { company: company || null, published: displayDate(publishedAt) ? `Published ${displayDate(publishedAt)}` : null, facts, applyUrl };
  const verdict = jobVerdict({ reviewed, prescan }, card, inclusion.minimumScore);
  const salaryCheck = reviewed?.salaryEligibility?.status && reviewed.salaryEligibility.status !== 'not_required'
    ? assessmentLabel(reviewed.salaryEligibility.status) : prescan?.status === 'below_minimum' ? 'Below your minimum' : null;
  // Checks contains only independent decision facts. An ineligible verdict already names the decisive gate, so location and
  // relocation are not repeated beneath it.
  const ineligible = card.stage === 'ineligible';
  const checks = fields('Checks', [
    ['Location', ineligible ? undefined : reviewed ? assessmentLabel(reviewed.matchStatus) : own(prescanLocations, prescan?.location) ? prescanLocations[prescan.location] : undefined],
    ['Relocation', ineligible ? undefined : assessmentLabel(reviewed?.relocation)],
    ['Salary', joinFacts([pay, salaryCheck]) || undefined],
    ...(record(reviewed?.gates) ? [['Career direction', gateLabels[reviewed.gates.direction]], ['Mandatory conditions', gateLabels[reviewed.gates.constraints]],
      ['Eligibility', gateLabels[reviewed.gates.eligibility]]] : []),
  ], 'No additional checks saved.');
  const sections = [
    checks,
    ...(reviewed ? reviewedSections(reviewed) : []),
    ...applicationSection(career, id),
    ...(imported ? [
      fields('Capture', [['Status', imported.complete ? 'Saved' : 'Needs full advert'],
        ['Source URL', imported.sourceUrl], ['Job URL', imported.url]], 'No capture details saved.'),
      section(imported.complete ? 'Original advert' : 'Captured listing text', imported.description?.trim()
        ? imported.description : 'No advert text was captured. Open the job page and capture its full advert.'),
    ] : []),
    ...(prescan ? [fields('Metadata', [
      ['Shortlist', joinFacts([prescanStatus(prescan), prescan.provider === 'openai' ? 'OpenAI Decisions' : prescan.provider,
        prescan.model, prescan.current ? 'current' : 'out of date'])],
    ], 'No shortlist metadata saved.')] : []),
  ];
  return { id, title, heading: roleTitle || title, card, block, header, verdict, sections };
}

async function reviewedRows(career) {
  const snapshot = { career };
  const matches = createMatchingTools({ store: { get: () => snapshot } }).find(tool => tool.name === 'career_matches');
  const rows = [];
  let offset = 0;
  do {
    const page = await matches.invoke({ offset, limit: 100 });
    rows.push(...page.matches);
    offset = page.nextOffset;
  } while (offset !== null);
  return rows;
}

function prescanRow(career, id, row, now) {
  const saved = { ...row, id };
  return { ...saved, provider: career.prescan.provider, model: career.prescan.model,
    current: currentPrescanRow(career, saved, now) };
}

// Candidates for the next agent run: every catalogue job without a current review, in catalogue order.
function jobInclusion(career, rows) {
  const candidates = entries(career.matching?.jobs).map(([id]) => id).filter(id => rows.get(id)?.reviewed?.reviewStatus !== 'current');
  return prescanInclusion(career, candidates, publicationWindowForRange(career.prescan?.publicationRange ?? DEFAULT_PUBLICATION_RANGE));
}

async function jobUnion(career) {
  const now = Date.now();
  const rows = new Map(entries(career.matching?.jobs).map(([id, metadata]) => [id, { id, metadata }]));
  for (const reviewed of await reviewedRows(career)) {
    if (!forbidden.has(reviewed.id)) {
      const item = rows.get(reviewed.id) ?? { id: reviewed.id };
      item.reviewed = reviewed;
      rows.set(reviewed.id, item);
    }
  }
  for (const [id, row] of entries(career.prescan?.rows)) {
    const item = rows.get(id) ?? { id };
    item.prescan = prescanRow(career, id, row, now);
    rows.set(id, item);
  }
  for (const [id, job] of entries(career.jobs)) {
    const item = rows.get(id) ?? { id };
    item.imported = { ...localJobMetadata(job), description: job.description, updatedAt: job.updatedAt };
    rows.set(id, item);
  }
  // Blocked jobs live only in the block list until it is removed.
  const isBlocked = blockedIds(career);
  for (const id of rows.keys()) if (isBlocked(id)) rows.delete(id);
  return { rows, inclusion: jobInclusion(career, rows) };
}

// Score order: current reviews by overall fit, then the pre-filter queue by score, then everything else, with
// ineligible jobs last; newer publication breaks ties, then ID. Recent order ignores stages entirely.
const stageOrder = { reviewed: 0, prefilter: 1, unscored: 2, ineligible: 3 };
function sortJobs(rows, inclusion, sort) {
  const sortable = [...rows.values()].map(row => {
    const publishedAt = row.imported?.publishedAt ?? row.metadata?.publishedAt ?? row.reviewed?.publishedAt ?? row.prescan?.publishedAt;
    const timestamp = typeof publishedAt === 'string' ? Date.parse(publishedAt) : NaN;
    const stage = cardStage(row, inclusion);
    const value = stage.stage === 'reviewed' ? -(stage.score ?? -1) : stage.stage === 'prefilter' ? stage.rank : 0;
    return { row, group: stageOrder[stage.stage], value, published: Number.isFinite(timestamp) ? timestamp : -Infinity };
  });
  return sortable.sort((a, b) => (sort === 'score' ? a.group - b.group || a.value - b.value : 0) ||
    (a.published === b.published ? 0 : a.published > b.published ? -1 : 1) ||
    (a.row.id < b.row.id ? -1 : a.row.id > b.row.id ? 1 : 0)).map(item => item.row);
}

function employmentItem(entry) {
  return {
    id: entry.id, title: entry.company, summary: `${entry.title}\n${entry.period}`,
    profileLink: true,
    sections: [
      fields('Employment', [['Company', entry.company], ['Title', entry.title], ['Dates', entry.period]]),
      fields('Inferred from CV', [['CV', entry.sourceName],
        ['Status', entry.stale ? 'CV changed since extraction. Ask your agent to refresh this career history.' : null]]),
    ],
  };
}


/** Read-only, allowlisted projections: never return the vault or binary source data. */
export function createCareerBrowser({ store }) {
  // Every operation reads the store once; canonical projections share that immutable snapshot.
  const detail = (kind, item, career) => kind === 'sources' ? sourceDetail(item) :
    kind === 'facts' ? factDetail(item, career) : applicationDetail(item, career);
  return {
    async list(args = {}) {
      validate(args, ['kind', 'offset', 'limit', 'sort']);
      const { kind, offset = 0, limit = 25, sort = 'score' } = args;
      if ((own(args, 'sort') && (kind !== 'jobs' || !['score', 'recent'].includes(args.sort)))) {
        fail('INVALID_INPUT', 'Use sort score or recent for Jobs only.');
      }
      if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100) {
        fail('INVALID_INPUT', 'Use limit 1–100 and a nonnegative safe integer offset.');
      }
      const career = readCareer(store);
      if (kind === 'career') {
        const entries = employmentHistory(career);
        const items = entries.slice(offset, offset + limit).map(employmentItem);
        return { items, total: entries.length, nextOffset: offset + items.length < entries.length ? offset + items.length : null };
      }
      if (kind === 'preferences') {
        const all = preferenceItems(career);
        const items = all.slice(offset, offset + limit);
        return { items, total: all.length, nextOffset: offset + items.length < all.length ? offset + items.length : null };
      }
      if (kind === 'jobs') {
        const { rows, inclusion } = await jobUnion(career);
        const sorted = sortJobs(rows, inclusion, sort);
        const items = sorted.slice(offset, offset + limit).map(row => jobItem(row, inclusion, career));
        // The divider sits before the first ranked card below the minimum score, reported once on the page that holds it.
        const below = row => { const { rank } = cardStage(row, inclusion); return rank !== null && career.prescan.rows[row.id].priority < inclusion.minimumScore; };
        const divider = sort === 'score' ? sorted.findIndex(below) - offset : -1;
        return { items, total: sorted.length, nextOffset: offset + items.length < sorted.length ? offset + items.length : null,
          cutoffIndex: divider >= 0 && divider < items.length ? divider : null,
          inclusion: { minimumScore: inclusion.minimumScore, included: inclusion.includedIds.size,
            scored: inclusion.ranked ? inclusion.rankedIds.length : null, stale: inclusion.stale, candidates: inclusion.candidates } };
      }
      if (kind === 'blocks') {
        const blocks = listBlocks(career);
        const items = blocks.slice(offset, offset + limit).map(entry => ({ id: entry.id, title: entry.label,
          summary: `${blockKinds[entry.kind]} · ${plural(entry.matches, 'saved job')}`, block: { kind: entry.kind } }));
        return { items, total: blocks.length, nextOffset: offset + items.length < blocks.length ? offset + items.length : null };
      }
      const records = entries(career[kind]);
      const items = records.slice(offset, offset + limit).map(([id, item]) => {
        if (kind === 'sources') return { id, title: text(item.name, 'Untitled source'), summary: [item.purpose === 'cv' ? '' : readable(item.purpose), item.archived ? 'Archived' : ''].filter(Boolean).join(' · ') };
        if (kind === 'facts') return { id, title: text(item.subject, 'Untitled fact'), summary: item.detail?.trim() ? item.detail : text(item.answer, '') };
        return { id, title: applicationTitle(item), summary: `${item.cv ? 'CV draft saved' : 'No CV draft'} · ${item.coverLetter ? 'Cover letter saved' : 'No cover letter draft'}` };
      });
      return { items, total: records.length, nextOffset: offset + items.length < records.length ? offset + items.length : null };
    },
    async read(args = {}) {
      validate(args, ['kind', 'id']);
      const { kind, id } = args;
      if (!own(args, 'id') || typeof id !== 'string' || !id.trim() || id.length > 500 || forbidden.has(id)) {
        fail('INVALID_INPUT', 'Choose a saved record ID.');
      }
      const career = readCareer(store);
      if (kind === 'career') {
        const entry = employmentHistory(career).find(row => row.id === id);
        if (!entry) fail('NOT_FOUND', 'This career entry is no longer available. Refresh Career.');
        return employmentItem(entry);
      }
      if (kind === 'preferences') {
        const item = preferenceItems(career).find(entry => entry.id === id);
        if (!item) fail('NOT_FOUND', 'This preference group is no longer available. Refresh Preferences.');
        return item;
      }
      if (kind === 'jobs') {
        const { rows, inclusion } = await jobUnion(career);
        const row = rows.get(id);
        if (!row) fail('NOT_FOUND', 'This saved job was not found. Refresh the list.');
        const { title, heading, header, verdict, sections } = jobItem(row, inclusion, career);
        return { title, heading, header, verdict, sections };
      }
      if (kind === 'blocks') {
        const entry = listBlocks(career).find(item => item.id === id);
        if (!entry) fail('NOT_FOUND', 'This block was already removed. Refresh the list.');
        return { title: entry.label, sections: [fields('Block', [['Type', blockKinds[entry.kind]],
          ['Saved jobs blocked', plural(entry.matches, 'job')], ['Added', displayDate(entry.createdAt)]], 'No block details saved.')] };
      }
      const item = lookup(career[kind], id);
      if (!item) fail('NOT_FOUND', 'This saved record was not found. Refresh the list.');
      return detail(kind, item, career);
    },
  };
}

/** Builds the connected-agent handoff only from a saved job and the exact requirement in its saved assessment. */
export function requirementContextPrompt({ store }, args) {
  if (!record(args) || ![Object.prototype, null].includes(Object.getPrototypeOf(args)) ||
      Reflect.ownKeys(args).some(key => !['id', 'requirement'].includes(key)) ||
      typeof args.id !== 'string' || !args.id.trim() || args.id.length > 500 || forbidden.has(args.id) ||
      typeof args.requirement !== 'string' || !args.requirement.trim() || args.requirement.length > 2000) {
    fail('INVALID_INPUT', 'Choose a saved job requirement.');
  }
  const career = readCareer(store);
  const savedJob = lookup(career.matching?.jobs, args.id) ?? lookup(career.jobs, args.id);
  if (!savedJob) fail('NOT_FOUND', 'This saved job was not found. Refresh the list.');
  const assessment = lookup(career.matching?.scores, args.id);
  if (!assessment || !Array.isArray(assessment.requirements)) {
    fail('NOT_FOUND', 'This job has no saved assessment.');
  }
  const requirement = assessment.requirements.find(item => record(item) && item.requirement === args.requirement);
  if (!requirement) fail('NOT_FOUND', 'This requirement is not in the saved assessment.');
  const title = text(savedJob.title, text(assessment.title, '')).trim();
  const company = text(savedJob.company, text(assessment.company, '')).trim();
  if (!title || !company) fail('NOT_FOUND', 'This saved job does not include a title and company.');
  return `Use the recruiters.rip skill to help me add context for this requirement in ${title} at ${company}: “${args.requirement}”. Read the saved job and my current career record. If this is a material gap, create or reuse its application, ask me one focused question, save my answer as a reusable fact, then reassess this job. Do not invent evidence or change unrelated preferences.`;
}

/** Opens the saved apply URL of a known job in the default browser; only http(s) URLs the vault already holds qualify. */
export async function openJobPage({ store, openExternal }, args) {
  if (!record(args) || typeof args.id !== 'string' || !args.id.trim() || forbidden.has(args.id)) fail('INVALID_INPUT', 'Choose a saved job.');
  const career = readCareer(store);
  const { rows } = await jobUnion(career);
  const row = rows.get(args.id);
  if (!row) fail('NOT_FOUND', 'This saved job was not found. Refresh the list.');
  const url = [row.imported?.applyUrl, row.metadata?.applyUrl, row.reviewed?.applyUrl, row.prescan?.applyUrl]
    .find(value => typeof value === 'string' && /^https?:\/\//.test(value));
  if (!url) fail('NOT_FOUND', 'This job has no saved job page.');
  await openExternal(url);
  return { opened: true, url };
}
