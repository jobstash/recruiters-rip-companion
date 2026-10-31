import { createRequire } from 'node:module';
import { cvHeading } from './mcp/application-tools.mjs';
import { renderableCv } from './mcp/cv-quality.mjs';
import { createMatchingTools } from './mcp/matching-tools.mjs';
import { fail, hash, readCareer } from './mcp/state.mjs';
import { reviewInclusion } from './mcp/review-queue.mjs';
import { localJobMetadata } from './mcp/job-tools.mjs';
import { publicationInWindow } from './mcp/publication-range.mjs';
import { blockedIds, listBlocks } from './mcp/blocklist.mjs';
import { employmentHistory } from './employment-browser.mjs';
import { preferenceItems } from './preferences-browser.mjs';
import { currentApplicationJob, sameApplicationJob } from './application-workflow.mjs';

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
  return { title: text(source.name, 'Untitled source'),
    ...(source.purpose === 'cv' && typeof source.contentHash === 'string' ? { deletion: { contentHash: source.contentHash } } : {}),
    sections: [
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
const savedJobPage = job => [job?.applyUrl, job?.url].find(value => typeof value === 'string' && /^https?:\/\//.test(value));
function applicationDetail(app, career) {
  return { title: applicationTitle(app), jobPage: Boolean(record(app.job) && savedJobPage(currentApplicationJob(career, app))), sections: [
    fields('Application', [
      ['Company', app.job?.company], ['Location', app.job?.location],
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
// A saved review with one of these verdicts makes the job ineligible: the card shows the verdict, never a number.
const ineligibleMatches = new Set(['incompatible_location', 'excluded']);
const ineligibleLabel = reviewed => ineligibleMatches.has(reviewed?.matchStatus) ? assessmentLabel(reviewed.matchStatus) : 'Location incompatible';
// A card shows where the job stands: reviewed by the agent (fit), ineligible (a saved verdict instead of a number), or
// open — waiting for the agent's next review. An established incompatibility (any saved gate fail, or relocation required
// against a refusal to relocate) is never offered again until the profile changes.
function cardStage({ id, reviewed }, inclusion) {
  const reviewCurrent = reviewed?.reviewStatus === 'current';
  const established = !reviewCurrent && inclusion.established(id);
  const ineligible = reviewCurrent ? ineligibleMatches.has(reviewed.matchStatus) : established;
  return {
    stage: ineligible ? 'ineligible' : reviewCurrent ? 'reviewed' : 'open',
    label: ineligible ? ineligibleLabel(reviewed) : null, established,
    score: Number.isInteger(reviewed?.overall) ? reviewed.overall : null,
    stale: reviewed ? !reviewCurrent : false,
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
function jobVerdict({ reviewed }, card) {
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
  // An open job has no verdict yet; a stale earlier review is still worth showing as context.
  if (!staleReview && !reason) return null;
  return { kind: 'open', number: null, numberLabel: null, headline: 'Not reviewed yet', detail: null,
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
  return [fields('Your application', [
    ['Created', displayDate(app.createdAt)],
    ['Interview answers', answers ? plural(answers, 'answer') : undefined],
  ], 'No application details saved.')];
}

function jobItem({ id, reviewed, imported, metadata }, inclusion, career) {
  const role = key => imported?.[key] ?? metadata?.[key] ?? reviewed?.[key];
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
    facts, ...cardStage({ id, reviewed }, inclusion),
  };
  // What the reader can offer to block besides the job itself.
  const block = { company: company || null, category: text(role('classification'), '') || null };
  const applyUrl = typeof role('applyUrl') === 'string' && /^https?:\/\//.test(role('applyUrl')) ? role('applyUrl') : null;
  const header = { company: company || null, published: displayDate(publishedAt) ? `Published ${displayDate(publishedAt)}` : null, facts, applyUrl };
  const verdict = jobVerdict({ reviewed }, card);
  const salaryCheck = reviewed?.salaryEligibility?.status && reviewed.salaryEligibility.status !== 'not_required'
    ? assessmentLabel(reviewed.salaryEligibility.status) : null;
  // Checks contains only independent decision facts. An ineligible verdict already names the decisive gate, so location and
  // relocation are not repeated beneath it.
  const ineligible = card.stage === 'ineligible';
  const checks = fields('Checks', [
    ['Location', ineligible ? undefined : reviewed ? assessmentLabel(reviewed.matchStatus) : undefined],
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

// Candidates for the next agent review: every catalogue job without a current review, in catalogue order.
function jobInclusion(career, rows) {
  const candidates = entries(career.matching?.jobs).map(([id]) => id).filter(id => rows.get(id)?.reviewed?.reviewStatus !== 'current');
  return reviewInclusion(career, candidates);
}

async function jobUnion(career) {
  const rows = new Map(entries(career.matching?.jobs).map(([id, metadata]) => [id, { id, metadata }]));
  for (const reviewed of await reviewedRows(career)) {
    if (!forbidden.has(reviewed.id)) {
      const item = rows.get(reviewed.id) ?? { id: reviewed.id };
      item.reviewed = reviewed;
      rows.set(reviewed.id, item);
    }
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

// Each view has one fixed order. Jobs: newest first. Reviewed: current reviews by fit, ineligible last. Newer
// publication breaks ties, then ID.
const jobViews = ['jobs', 'reviewed'];
const stageOrder = { reviewed: 0, open: 1, ineligible: 2 };
function sortJobs(staged, view) {
  const sortable = staged.map(({ row, stage }) => {
    const publishedAt = row.imported?.publishedAt ?? row.metadata?.publishedAt ?? row.reviewed?.publishedAt;
    const timestamp = typeof publishedAt === 'string' ? Date.parse(publishedAt) : NaN;
    const value = stage.stage === 'reviewed' ? -(stage.score ?? -1) : 0;
    return { row, group: stageOrder[stage.stage], value, published: Number.isFinite(timestamp) ? timestamp : -Infinity };
  });
  return sortable.sort((a, b) => (view === 'jobs' ? 0 : a.group - b.group || a.value - b.value) ||
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


// Saved PDFs are historical artifacts, not a claim that the current draft is ready.
function documentApplication(career, kind, id) {
  if (kind === 'applications') {
    const app = lookup(career.applications, id);
    if (!app) fail('NOT_FOUND', 'This application is no longer saved. Refresh the list.');
    return { app, applicationId: id, job: currentApplicationJob(career, app) };
  }
  const saved = lookup(career.jobs, id) ?? lookup(career.matching?.jobs, id) ?? lookup(career.matching?.scores, id);
  if (!saved || blockedIds(career)(id)) fail('NOT_FOUND', 'This job is no longer available. Refresh the list.');
  const job = { ...saved, id };
  const matches = entries(career.applications).filter(([, app]) => sameApplicationJob(currentApplicationJob(career, app), job));
  if (matches.length > 1) fail('AMBIGUOUS_APPLICATION', 'More than one application matches this job. Open the intended application in Applications.');
  return { app: matches[0]?.[1], applicationId: matches[0]?.[0], job };
}
function savedDocument(career, kind, id, document) {
  const binding = documentApplication(career, kind, id);
  const exported = [...(binding.app?.exports ?? [])].reverse().find(item => item.kind === document && item.format === 'pdf');
  if (!exported) fail('DOCUMENT_MISSING', `No saved ${document === 'cv' ? 'CV' : 'letter'} PDF is available for this application.`);
  return { exported, token: hash({ kind, id, applicationId: binding.applicationId, job: binding.job,
    applicationJob: binding.app.job, exported }) };
}

/** Read-only, allowlisted projections: never return the vault or binary source data. */
export function createCareerBrowser({ store, files, openPath }) {
  // List/read projections share one immutable career snapshot.
  const detail = (kind, item, career) => kind === 'sources' ? sourceDetail(item) :
    kind === 'facts' ? factDetail(item, career) : applicationDetail(item, career);
  async function documents(career, kind, id) {
    let binding;
    try { binding = documentApplication(career, kind, id); }
    catch (error) { return { documents: [], documentNotice: error.message }; }
    if (!binding.app) return {};
    const items = await Promise.all(['cv', 'cover_letter'].map(async document => {
      const label = document === 'cv' ? 'CV' : 'letter';
      let saved;
      try { saved = savedDocument(career, kind, id, document); }
      catch { return { kind: document, status: 'missing', label, message: `No saved ${label} PDF.` }; }
      const createdAt = saved.exported.createdAt;
      try {
        if (!files) throw new Error('File access unavailable');
        await files.resolveExport(saved.exported.uri);
        return { kind: document, status: 'saved', label, token: saved.token, createdAt };
      } catch {
        return { kind: document, status: 'unavailable', label, createdAt, message: `Saved ${label} PDF unavailable.` };
      }
    }));
    return { documents: items };
  }
  return {
    async openDocument(args = {}) {
      validate(args, ['kind', 'id', 'document', 'token']);
      if (!['jobs', 'applications'].includes(args.kind) || typeof args.id !== 'string' || !args.id.trim() ||
          args.id.length > 500 || forbidden.has(args.id) || !['cv', 'cover_letter'].includes(args.document) ||
          typeof args.token !== 'string' || !/^[a-f0-9]{64}$/.test(args.token)) fail('INVALID_INPUT', 'Choose a saved application PDF.');
      const selection = () => {
        const saved = savedDocument(readCareer(store), args.kind, args.id, args.document);
        if (saved.token !== args.token) fail('DOCUMENT_CHANGED', 'This application or its saved PDF changed. Select it again.');
        return saved.exported;
      };
      const exported = selection();
      if (!files || !openPath) fail('DOCUMENT_UNAVAILABLE', 'Saved PDF access is unavailable.');
      let filename;
      try {
        filename = await files.resolveExport(exported.uri);
        selection();
        // Revalidate the private resource after checking the selected application again.
        const currentFilename = await files.resolveExport(exported.uri);
        selection();
        if (filename !== currentFilename) fail('DOCUMENT_CHANGED', 'The saved PDF location changed. Select it again.');
      } catch (error) {
        if (['DOCUMENT_CHANGED', 'IDENTITY_CHANGED', 'NOT_FOUND', 'AMBIGUOUS_APPLICATION', 'DOCUMENT_MISSING'].includes(error.code)) throw error;
        fail('DOCUMENT_UNAVAILABLE', 'The saved PDF is missing, damaged or unavailable. Your saved draft is unchanged.');
      }
      let error;
      try { error = await openPath(filename); }
      catch { error = true; }
      if (error) fail('DOCUMENT_UNAVAILABLE', 'The saved PDF could not be opened. Check your default PDF app and try again.');
      return { opened: true };
    },
    async list(args = {}) {
      validate(args, ['kind', 'offset', 'limit', 'view']);
      const { kind, offset = 0, limit = 25, view = 'jobs' } = args;
      if ((own(args, 'view') && (kind !== 'jobs' || !jobViews.includes(args.view)))) {
        fail('INVALID_INPUT', 'Use view jobs or reviewed for Jobs only.');
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
        const staged = [...rows.values()].map(row => ({ row, stage: cardStage(row, inclusion) }));
        // Jobs is the loaded publication window (captures always count); reviews outside it stay under Reviewed.
        const feedWindow = career.matching?.window;
        const inWindow = ({ row }) => Boolean(row.imported) || !feedWindow ||
          publicationInWindow(row.metadata?.publishedAt ?? row.reviewed?.publishedAt, feedWindow);
        const inView = { jobs: inWindow, reviewed: ({ stage }) => stage.stage === 'reviewed' || stage.stage === 'ineligible' };
        const counts = { jobs: staged.filter(inWindow).length, reviewed: staged.filter(inView.reviewed).length,
          applications: entries(career.applications).length, blocks: listBlocks(career).length };
        const sorted = sortJobs(staged.filter(inView[view]), view);
        const items = sorted.slice(offset, offset + limit).map(row => jobItem(row, inclusion, career));
        return { items, total: sorted.length, nextOffset: offset + items.length < sorted.length ? offset + items.length : null, counts,
          inclusion: { included: inclusion.includedIds.size, candidates: inclusion.candidates } };
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
        return { title, heading, header, verdict, sections, ...await documents(career, kind, id) };
      }
      if (kind === 'blocks') {
        const entry = listBlocks(career).find(item => item.id === id);
        if (!entry) fail('NOT_FOUND', 'This block was already removed. Refresh the list.');
        return { title: entry.label, sections: [fields('Block', [['Type', blockKinds[entry.kind]],
          ['Saved jobs blocked', plural(entry.matches, 'job')], ['Added', displayDate(entry.createdAt)]], 'No block details saved.')] };
      }
      const item = lookup(career[kind], id);
      if (!item) fail('NOT_FOUND', 'This saved record was not found. Refresh the list.');
      return { ...detail(kind, item, career), ...(kind === 'applications' ? await documents(career, kind, id) : {}) };
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
  validate(args, ['kind', 'id']);
  if (!['jobs', 'applications'].includes(args.kind) || typeof args.id !== 'string' || !args.id.trim() ||
      args.id.length > 500 || forbidden.has(args.id)) fail('INVALID_INPUT', 'Choose a saved job or application.');
  const career = readCareer(store);
  let url;
  if (args.kind === 'applications') {
    const app = lookup(career.applications, args.id);
    if (!app || !record(app.job)) fail('NOT_FOUND', 'This application is no longer saved. Refresh the list.');
    url = savedJobPage(currentApplicationJob(career, app));
  } else {
    const { rows } = await jobUnion(career);
    const row = rows.get(args.id);
    if (!row) fail('NOT_FOUND', 'This saved job was not found. Refresh the list.');
    url = [row.imported?.applyUrl, row.metadata?.applyUrl, row.reviewed?.applyUrl]
      .find(value => typeof value === 'string' && /^https?:\/\//.test(value));
  }
  if (!url) fail('NOT_FOUND', 'This job has no saved job page.');
  await openExternal(url);
  return { opened: true, url };
}
