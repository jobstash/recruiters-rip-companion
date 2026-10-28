import { fail } from './state.mjs';
import { localJob, localJobMetadata } from './job-tools.mjs';

// The user's block list: a job, every job of a company or every job of a category (classification) is kept out of
// the agent's next review, recommendations and the Jobs list until the entry is removed.
export const BLOCK_KINDS = ['job', 'company', 'category'];
const forbidden = new Set(['__proto__', 'prototype', 'constructor']);
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const label = value => typeof value === 'string' && value.trim() ? value.trim() : null;
/** Company and category names compare case-, spacing- and underscore-insensitively ("SMART_CONTRACTS" = "Smart Contracts"). */
export const blockKey = value => typeof value === 'string' ? value.normalize('NFKC').trim().toLowerCase().replace(/[\s_]+/g, ' ') : '';

/** The title, company and category the companion knows for a saved job, from any of its stores. */
export function knownJob(career, id) {
  if (typeof id !== 'string' || forbidden.has(id)) return null;
  const sources = [localJob(career, id) && localJobMetadata(localJob(career, id)),
    record(career.matching?.jobs) && Object.hasOwn(career.matching.jobs, id) ? career.matching.jobs[id] : null].filter(record);
  if (!sources.length) return null;
  const first = key => sources.map(source => label(source[key])).find(Boolean) ?? null;
  return { id, title: first('title'), company: first('company'), classification: first('classification') };
}

function savedEntries(career) {
  const saved = record(career.blocklist) ? career.blocklist : {};
  return Object.entries(saved).filter(([id, entry]) => !forbidden.has(id) && record(entry) && BLOCK_KINDS.includes(entry.kind) &&
    typeof entry.value === 'string' && entry.value);
}

/** `job => entry | null` for a job-like `{ id, company, classification }`; the entry says what blocks it. */
export function blockFilter(career) {
  const jobs = new Map(), companies = new Map(), categories = new Map();
  for (const [id, entry] of savedEntries(career)) {
    const value = { id, ...entry };
    if (entry.kind === 'job') jobs.set(entry.value, value);
    else (entry.kind === 'company' ? companies : categories).set(blockKey(entry.value), value);
  }
  if (!jobs.size && !companies.size && !categories.size) return () => null;
  return job => jobs.get(job?.id) ?? companies.get(blockKey(job?.company)) ?? categories.get(blockKey(job?.classification)) ?? null;
}

/** `id => boolean` over saved jobs; unknown IDs are never blocked. */
export function blockedIds(career) {
  const blocked = blockFilter(career);
  return id => Boolean(blocked(knownJob(career, id) ?? { id }));
}

/** Every saved job ID the companion can show: catalogue and local captures. */
function savedJobIds(career) {
  return new Set([career.matching?.jobs, career.jobs]
    .flatMap(store => record(store) ? Object.keys(store) : []).filter(id => !forbidden.has(id)));
}

/** Entries newest first with how many saved jobs each one currently blocks. */
export function listBlocks(career) {
  const entries = savedEntries(career).map(([id, entry]) => ({ id, kind: entry.kind, value: entry.value,
    label: label(entry.label) ?? entry.value, createdAt: typeof entry.createdAt === 'string' ? entry.createdAt : null, matches: 0 }));
  const byId = new Map(entries.map(entry => [entry.id, entry]));
  const blocked = blockFilter(career);
  for (const id of savedJobIds(career)) {
    const entry = blocked(knownJob(career, id));
    if (entry) byId.get(entry.id).matches++;
  }
  return entries.sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? '') || a.id.localeCompare(b.id));
}

/** Block the saved job `id`, its company or its category. Repeating a block keeps the original entry. */
export function addBlock(career, { id, kind }) {
  if (!BLOCK_KINDS.includes(kind)) fail('INVALID_INPUT', 'Block a job, its company or its category.');
  const job = knownJob(career, id);
  if (!job) fail('NOT_FOUND', 'This saved job was not found. Refresh the list.');
  const value = kind === 'job' ? job.id : kind === 'company' ? job.company : job.classification;
  if (!value) fail('INVALID_INPUT', kind === 'company' ? 'This job has no company to block.' : 'This job has no category to block.');
  const entryId = kind === 'job' ? `job:${job.id}` : `${kind}:${blockKey(value)}`;
  const saved = career.blocklist = record(career.blocklist) ? career.blocklist : {};
  if (!Object.hasOwn(saved, entryId)) saved[entryId] = { kind, value,
    label: kind === 'job' ? [job.title, job.company].filter(Boolean).join(' — ') || job.id : value, createdAt: new Date().toISOString() };
  return { id: entryId, ...saved[entryId] };
}

export function removeBlock(career, id) {
  if (typeof id !== 'string' || forbidden.has(id) || !record(career.blocklist) || !Object.hasOwn(career.blocklist, id))
    fail('NOT_FOUND', 'This block was already removed. Refresh the list.');
  delete career.blocklist[id];
}
