import { createRequire } from 'node:module';
import { cvHeading } from './mcp/application-tools.mjs';
import { renderableCv } from './mcp/cv-quality.mjs';
import { createMatchingTools } from './mcp/matching-tools.mjs';
import { fail, readCareer } from './mcp/state.mjs';
import { currentPrescanRow } from './prescan/state.mjs';
import { localJobMetadata } from './mcp/job-tools.mjs';

const kinds = ['sources', 'facts', 'jobs', 'applications'];
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
const prescanStatuses = {
  unavailable: 'Original advert unavailable', oversize: 'Input exceeds the provider limit', refused: 'Provider declined assessment',
};
const prescanScore = row => row?.status === 'scored' && Number.isInteger(row.priority) && row.priority >= 0 && row.priority <= 100
  ? row.priority : -1;
const prescanPriority = row => prescanScore(row) >= 0 ? `${row.priority}/100` : 'Not scored';
const prescanStatus = row => prescanScore(row) >= 0 ? 'Scored' : prescanStatuses[row.status] || 'Not scored';
const cardScoreStatuses = new Set(['unavailable', 'refused', 'oversize']);
// A job has one score: the best-known assessment. A current review supersedes the pre-filter, which only
// exists to pick what to review; stale results rank below current ones and unscored jobs come last.
const scoreGroups = { 'reviewed:false': 0, 'prefilter:false': 1, 'reviewed:true': 2, 'prefilter:true': 3 };
const scoreGroup = score => score.source ? scoreGroups[`${score.source}:${score.stale}`] : 4;
function cardScore(reviewed, prescan) {
  const review = reviewed && Number.isInteger(reviewed.overall) ? { value: reviewed.overall, source: 'reviewed',
    stale: reviewed.reviewStatus !== 'current', status: 'scored', decision: assessmentLabel(reviewed.decision) ?? null } : null;
  const priority = prescanScore(prescan) >= 0 ? { value: prescan.priority, source: 'prefilter',
    stale: prescan.current !== true, status: 'scored', decision: null } : null;
  const scored = [review, priority].filter(Boolean).sort((a, b) => scoreGroup(a) - scoreGroup(b))[0];
  return scored ?? { value: null, source: null, stale: false,
    status: !prescan ? null : cardScoreStatuses.has(prescan.status) ? prescan.status : 'unscored', decision: null };
}
const bandLabel = band => typeof band === 'string' && band ? band.replace(/^./, letter => letter.toUpperCase()) : undefined;
const overallLabel = row => Number.isInteger(row.overall) ? `${row.overall}/100 (${bandLabel(row.band)})` : 'Unavailable';
const gateLabels = { pass: 'Passes', flag: 'Needs confirmation', fail: 'Fails' };
const outOf100 = value => Number.isInteger(value) ? `${value}/100` : undefined;
const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;

function reviewedSections(row) {
  const requirements = Array.isArray(row.requirements) ? row.requirements.filter(record) : [];
  return [
    fields('Reviewed fit', [
      ['Status', assessmentLabel(row.reviewStatus)],
      ['Overall fit', overallLabel(row), Number.isInteger(row.overall) ? 'numeric' : undefined],
      ['Saved decision', assessmentLabel(row.decision) || 'No saved decision'],
      ['Location match', assessmentLabel(row.matchStatus)],
      ['Pairwise rank', Number.isFinite(row.pairwiseWins) ? `${plural(row.pairwiseWins, 'win')} of ${plural(row.pairwiseCompared, 'comparison')}` : undefined],
    ], 'No assessment saved.'),
    ...(record(row.dimensions) ? [fields('Fit breakdown', [
      ['Direction', outOf100(row.dimensions.direction), 'numeric'], ['Capability', outOf100(row.dimensions.capability), 'numeric'],
      ['Scope', outOf100(row.dimensions.scope), 'numeric'], ['Preferences', outOf100(row.dimensions.preferences), 'numeric'],
    ], 'No breakdown saved.')] : []),
    ...(record(row.gates) ? [fields('Gates', [
      ['Career direction', gateLabels[row.gates.direction]], ['Mandatory conditions', gateLabels[row.gates.constraints]],
      ['Eligibility', gateLabels[row.gates.eligibility]],
    ], 'No gates saved.')] : []),
    ...(requirements.length ? [fields('Requirements', requirements.map(item =>
      [text(item.requirement, 'Unnamed requirement'), [readable(item.importance), readable(item.evidence)].filter(Boolean).join(' · ')]),
    'No requirements saved.')] : []),
    section('Review reason', text(row.reason, 'No reason is saved.')),
  ];
}

function prescanSection(row) {
  return fields('Pre-filter', [
    ['Priority', prescanPriority(row), prescanScore(row) >= 0 ? 'numeric' : undefined],
    ['Status', prescanStatus(row)], ['Freshness', row.current ? 'Current' : 'Out of date'],
    ['Provider', row.provider === 'openai' ? 'OpenAI Decisions' : row.provider], ['Model', row.model],
  ], 'No pre-filter result saved.');
}

function jobItem({ id, reviewed, prescan, imported, metadata }) {
  const role = key => imported?.[key] ?? metadata?.[key] ?? reviewed?.[key] ?? prescan?.[key];
  const roleTitle = text(role('title'), '');
  const company = text(role('company'), '');
  const title = [roleTitle, company].filter(Boolean).join(' — ') || 'Job details unavailable';
  const salary = role('salary');
  const range = salary && (amount(salary.stated) ?? [amount(salary.minimum), amount(salary.maximum)].filter(Boolean).join('–'));
  const pay = range ? [salary.currency, range, salary.period && `per ${salary.period}`].filter(Boolean).join(' ') : null;
  const reviewCurrent = reviewed?.reviewStatus === 'current';
  const publishedAt = role('publishedAt');
  const chip = (kind, value) => typeof value === 'string' && value ? [{ kind, text: value }] : [];
  // "Remote" as the posted location and "remote" as the work mode are one fact, not two.
  const locationChip = (place, mode) => [place, mode && place?.toLowerCase() !== mode.toLowerCase() ? mode : null]
    .filter(value => typeof value === 'string' && value).join(' · ');
  const card = {
    title: roleTitle || title, company: company || null,
    publishedAt: typeof publishedAt === 'string' && Number.isFinite(Date.parse(publishedAt)) ? publishedAt : null,
    score: cardScore(reviewed, prescan),
    chips: [...chip('seniority', role('seniority')), ...chip('salary', pay),
      ...chip('location', locationChip(role('city') || role('location'), role('workMode'))),
      ...chip('commitment', role('commitment')), ...chip('classification', role('classification'))],
  };
  const review = reviewed ? reviewedSections(reviewed) : [];
  // A current review supersedes the pre-filter, so the reader never shows both; a stale review follows a current pre-filter.
  const preliminary = prescan && !reviewCurrent ? [prescanSection(prescan)] : [];
  return { id, title, card, sections: [
    ...(reviewed && !prescan?.current ? [...review, ...preliminary] : [...preliminary, ...review]),
    ...(imported ? [
      fields('Capture', [['Status', imported.complete ? 'Saved' : 'Needs full advert'],
        ['Source URL', imported.sourceUrl], ['Job URL', imported.url]], 'No capture details saved.'),
      section(imported.complete ? 'Original advert' : 'Captured listing text', imported.description?.trim()
        ? imported.description : 'No advert text was captured. Open the job page and capture its full advert.'),
    ] : []),
    fields('Role', [
      ['City', role('city')], ['Location', role('location')], ['Work mode', role('workMode')],
      ['Relocation', assessmentLabel(reviewed?.relocation)], ['Salary', pay || 'Not stated'],
      ['Against your minimum', reviewed?.salaryEligibility?.status === 'not_required' ? undefined : assessmentLabel(reviewed?.salaryEligibility?.status)],
      ['Published', displayDate(role('publishedAt')) || 'Not stated'], ['Apply URL', role('applyUrl')],
    ], 'No role details saved.'),
  ] };
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

async function jobRows(career, sort) {
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
  // Sort the whole saved union by the single effective score: current review, current pre-filter, stale review,
  // stale pre-filter, then unscored; newer publication breaks ties, then ID.
  const sortable = [...rows.values()].map(row => {
    const publishedAt = row.imported?.publishedAt ?? row.metadata?.publishedAt ?? row.reviewed?.publishedAt ?? row.prescan?.publishedAt;
    const timestamp = typeof publishedAt === 'string' ? Date.parse(publishedAt) : NaN;
    const score = cardScore(row.reviewed, row.prescan);
    return { row, group: scoreGroup(score), value: score.value ?? -1, published: Number.isFinite(timestamp) ? timestamp : -Infinity };
  });
  return sortable.sort((a, b) => (sort === 'score' ? a.group - b.group || b.value - a.value : 0) ||
    (a.published === b.published ? 0 : a.published > b.published ? -1 : 1) ||
    (a.row.id < b.row.id ? -1 : a.row.id > b.row.id ? 1 : 0)).map(item => item.row);
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
      if (kind === 'jobs') {
        const rows = await jobRows(career, sort);
        const items = rows.slice(offset, offset + limit).map(jobItem);
        return { items, total: rows.length, nextOffset: offset + items.length < rows.length ? offset + items.length : null };
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
      if (kind === 'jobs') {
        const assessment = lookup(career.matching?.scores, id);
        const savedPrescan = lookup(career.prescan?.rows, id);
        const captured = lookup(career.jobs, id);
        const metadata = lookup(career.matching?.jobs, id);
        if (!assessment && !savedPrescan && !captured && !metadata) fail('NOT_FOUND', 'This saved job was not found. Refresh the list.');
        const now = Date.now();
        // Project every final assessment so pairwise comparisons stay current, then pick this job.
        const reviewed = assessment ? (await reviewedRows(career)).find(row => row.id === id) ?? null : null;
        const prescan = savedPrescan ? prescanRow(career, id, savedPrescan, now) : null;
        const imported = captured ? { ...localJobMetadata(captured), description: captured.description } : null;
        const { title, sections } = jobItem({ id, reviewed, prescan, imported, metadata });
        return { title, sections };
      }
      const item = lookup(career[kind], id);
      if (!item) fail('NOT_FOUND', 'This saved record was not found. Refresh the list.');
      return detail(kind, item, career);
    },
  };
}
