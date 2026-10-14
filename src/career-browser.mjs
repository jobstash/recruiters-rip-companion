import { createRequire } from 'node:module';
import { createMatchingTools } from './mcp/matching-tools.mjs';
import { fail, readCareer } from './mcp/state.mjs';

const kinds = ['sources', 'facts', 'rankings', 'applications'];
const forbidden = new Set(['__proto__', 'prototype', 'constructor']);
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (value, key) => record(value) && Object.hasOwn(value, key);
const text = (value, fallback = 'Not saved') => typeof value === 'string' && value.length ? value : fallback;
const scalar = value => typeof value === 'string' ? value : typeof value === 'number' || typeof value === 'boolean' ? String(value) : 'Not saved';
const section = (heading, value) => ({ heading, text: text(value) });
const metadata = entries => entries.filter(([, value]) => value !== null && value !== undefined && value !== '').map(([label, value]) => `${label}: ${scalar(value)}`).join('\n');
const readable = value => typeof value === 'string' && value ? value === 'cv' ? 'CV' : value.replaceAll('_', ' ').replace(/^./, letter => letter.toUpperCase()) : undefined;
const factTitle = fact => [readable(fact.kind) || 'Career fact', text(fact.employer, ''), text(fact.role, '')].filter(Boolean).join(' — ');
const entries = value => record(value) ? Object.entries(value).filter(([id, item]) => !forbidden.has(id) && record(item)) : [];
const lookup = (value, id) => !forbidden.has(id) && own(value, id) && record(value[id]) ? value[id] : null;

function validate(args, fields) {
  if (!record(args) || ![Object.prototype, null].includes(Object.getPrototypeOf(args)) ||
      Reflect.ownKeys(args).some(key => !fields.includes(key)) || !own(args, 'kind') || !kinds.includes(args.kind)) {
    fail('INVALID_INPUT', `Provide kind (${kinds.join(', ')}) and only ${fields.join(', ')}.`);
  }
}

function sourceDetail(source) {
  return { title: text(source.name, 'Untitled source'), sections: [
    section('Source details', metadata([
      ['Status', source.archived ? 'Archived' : 'Current'], ['Purpose', readable(source.purpose)],
      ['Created', source.createdAt],
    ])),
    section('Extracted source text', text(source.text, 'No extracted text is saved for this source.')),
  ] };
}

function factDetail(fact) {
  return { title: factTitle(fact), sections: [
    section('Career detail', text(fact.statement, 'No statement is saved.')),
    section('Role and dates', metadata([
      ['Status', fact.status === 'active' ? undefined : readable(fact.status)],
      ['Employer', fact.employer], ['Role', fact.role],
      ['Start date', fact.startDate], ['End date', fact.endDate],
    ]) || 'No role dates saved.'),
  ] };
}

let renderCv;
function cvText(draft) {
  if (!record(draft.baseline) || !Array.isArray(draft.baseline.entries) || !draft.baseline.entries.length) {
    return 'No CV wording is saved in this draft.';
  }
  // Use the same header overrides and reading order as exported CVs.
  renderCv ??= createRequire(import.meta.url)('./generated/document-engine.cjs').renderCareerCvText;
  return text(renderCv(draft), 'No CV wording is saved in this draft.');
}
function draftSections(kind, draft, historical = false) {
  const label = `${historical ? 'Earlier ' : ''}${kind === 'cv' ? 'CV' : 'Cover letter'}`;
  if (!record(draft)) return [section(label, `No ${kind === 'cv' ? 'CV' : 'cover letter'} draft is saved.`)];
  const heading = historical && draft.createdAt ? `${label} — ${draft.createdAt}` : label;
  const wording = kind === 'cv' ? cvText(draft) :
    (Array.isArray(draft.sections) ? draft.sections.map(item => typeof item?.text === 'string' ? item.text : '').join('\n\n') : '');
  return [...(!historical && draft.createdAt ? [section(`${heading} saved`, draft.createdAt)] : []),
    section(heading, text(wording, 'No cover letter wording is saved in this draft.'))];
}
function applicationTitle(app) {
  return [text(app.job?.title, ''), text(app.job?.company, '')].filter(Boolean).join(' — ') || 'Untitled application';
}
function applicationDetail(app, career) {
  const source = typeof app.sourceId === 'string' ? lookup(career.sources, app.sourceId) : null;
  return { title: applicationTitle(app), sections: [
    section('Application details', metadata([
      ['Job', app.job?.title], ['Company', app.job?.company],
      ['Created', app.createdAt], ['Updated', app.updatedAt], ['Source document', source?.name],
      ['Before applying', app.evidenceRevision !== career.evidenceRevision ? 'Your profile has changed since this draft. Update it for the job before sending.' : undefined],
    ])),
    ...draftSections('cv', app.cv), ...draftSections('cover_letter', app.coverLetter),
    ...(Array.isArray(app.cvHistory) ? app.cvHistory.flatMap(draft => draftSections('cv', draft, true)) : []),
    ...(Array.isArray(app.coverLetterHistory) ? app.coverLetterHistory.flatMap(draft => draftSections('cover_letter', draft, true)) : []),
  ] };
}
function rankingItem(row) {
  const title = [text(row.title, ''), text(row.company, '')].filter(Boolean).join(' — ') || 'Job details unavailable';
  const score = row.score == null ? 'Unavailable' : scalar(row.score);
  const labels = {
    recommend: 'Recommended', clarify: 'Needs clarification', skip: 'Not recommended',
    current: 'Current assessment', needs_review: 'Needs reassessment',
    eligible: 'Location compatible', requires_relocation: 'Relocation required',
    needs_location_confirmation: 'Location needs confirmation', incompatible_location: 'Location incompatible',
    zero_fit: 'No fit', unavailable: 'Assessment unavailable',
    required: 'Required', not_required: 'Not required', unclear: 'Unclear',
    below_minimum: 'Below your minimum', range_can_meet_minimum: 'Range can meet your minimum',
    meets_minimum: 'Meets your minimum', not_comparable: 'Cannot compare with your minimum',
    unbounded_range: 'Upper salary bound not stated', not_stated: 'Salary not stated',
  };
  const label = value => own(labels, value) ? labels[value] : readable(value);
  const salary = row.salary;
  const hasSalary = salary && [salary.minimum, salary.maximum, salary.stated].some(Number.isFinite);
  return { id: row.id, title, summary: `${score} · ${label(row.decision) || 'No saved decision'}`, sections: [
    section('Job fit', metadata([
      ['Score', score], ['Decision', label(row.decision) || 'No saved decision'], ['Before applying', row.reviewStatus === 'needs_review' ? 'Reassess against your current profile.' : undefined], ['Location match', label(row.matchStatus)],
    ])),
    section('Reason', text(row.reason, 'No reason is saved.')),
    section('Location', metadata([['City', row.city], ['Location', row.location], ['Work mode', row.workMode], ['Relocation', label(row.relocation)]]) || 'Location not stated'),
    section('Pay', hasSalary ? metadata([
      ['Minimum', salary.minimum], ['Maximum', salary.maximum], ['Stated amount', salary.stated],
      ['Currency', salary.currency || 'Not stated'], ['Period', salary.period || 'Not stated'],
      ['Compared with your minimum', row.salaryEligibility?.status === 'not_required' ? undefined : label(row.salaryEligibility?.status)],
    ]) : 'Salary not stated'),
    section('Job details', metadata([['Published', row.publishedAt || 'Date not stated'], ['Apply URL', row.applyUrl]])),
  ] };
}

/** Read-only, allowlisted projections: never return the vault or binary source data. */
export function createCareerBrowser({ store }) {
  const matches = createMatchingTools({ store }).find(tool => tool.name === 'career_matches');
  const detail = (kind, item, career) => kind === 'sources' ? sourceDetail(item) :
    kind === 'facts' ? factDetail(item, career) : applicationDetail(item, career);
  return {
    async list(args = {}) {
      validate(args, ['kind', 'offset', 'limit']);
      const { kind, offset = 0, limit = 25 } = args;
      if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 100) {
        fail('INVALID_INPUT', 'Use limit 1–100 and a nonnegative safe integer offset.');
      }
      if (kind === 'rankings') {
        const page = await matches.invoke({ offset, limit });
        return { items: page.matches.map(rankingItem), total: page.total, nextOffset: page.nextOffset };
      }
      const career = readCareer(store);
      const records = entries(career[kind]);
      const items = records.slice(offset, offset + limit).map(([id, item]) => {
        if (kind === 'sources') return { id, title: text(item.name, 'Untitled source'), summary: [item.archived ? 'Archived' : 'Current', readable(item.purpose)].filter(Boolean).join(' · ') };
        if (kind === 'facts') return { id, title: factTitle(item), summary: readable(item.status) || 'Status unknown' };
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
      if (kind === 'rankings') {
        const assessment = lookup(career.matching?.scores, id);
        if (!assessment) fail('NOT_FOUND', 'This saved ranking was not found. Refresh the list.');
        // A single-key snapshot keeps canonical assessment semantics without paging the archive.
        const snapshot = { career: { ...career, matching: {
          jobs: { [id]: lookup(career.matching?.jobs, id) ?? {} }, scores: { [id]: assessment },
        } } };
        const single = createMatchingTools({ store: { get: () => snapshot } }).find(tool => tool.name === 'career_matches');
        const page = await single.invoke({ offset: 0, limit: 1 });
        const { title, sections } = rankingItem(page.matches[0]);
        return { title, sections };
      }
      const item = lookup(career[kind], id);
      if (!item) fail('NOT_FOUND', 'This saved record was not found. Refresh the list.');
      return detail(kind, item, career);
    },
  };
}
