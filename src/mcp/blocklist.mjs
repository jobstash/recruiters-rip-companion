import { fail } from './state.mjs';
import { localJob, localJobMetadata } from './job-tools.mjs';
import { sameApplicationJob } from '../application-workflow.mjs';

// Blocks exclude jobs from discovery and stop application work without deleting saved drafts.
export const BLOCK_KINDS = ['job', 'company', 'category'];
const forbidden = new Set(['__proto__', 'prototype', 'constructor']);
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const label = value => typeof value === 'string' && value.trim() ? value.trim() : null;
/** Display names and slugs share an identity ("smart-contracts" = "SMART_CONTRACTS" = "Smart Contracts"). */
export const blockKey = value => typeof value === 'string' ? value.normalize('NFKC').toLowerCase().replace(/[\s_\p{Pd}]+/gu, ' ').trim() : '';

/** The title, company and category the companion knows for a saved job, from any of its stores. */
export function knownJob(career, id) {
  if (typeof id !== 'string' || forbidden.has(id)) return null;
  const sources = [localJob(career, id) && localJobMetadata(localJob(career, id)),
    record(career.matching?.jobs) && Object.hasOwn(career.matching.jobs, id) ? career.matching.jobs[id] : null,
    ...Object.values(career.applications ?? {}).filter(app => app.job?.id === id).map(app => app.job)].filter(record);
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
  const direct = job => jobs.get(job?.id) ?? jobs.get(job?.shortUUID) ??
    companies.get(blockKey(typeof job?.company === 'string' ? job.company : job?.company?.name)) ??
    companies.get(blockKey(job?.company?.slug)) ?? categories.get(blockKey(job?.classification)) ?? null;
  const applications = new Map();
  for (const app of Object.values(career.applications ?? {})) {
    const entry = direct(app.job);
    if (entry && app.job?.id) applications.set(app.job.id, entry);
  }
  return job => direct(job) ?? (job?.id ? direct(career.jobs?.[job.id]) ?? direct(career.matching?.jobs?.[job.id]) ??
    applications.get(job.id) : null) ?? null;
}

/** `id => boolean` over saved jobs, including directly blocked IDs no longer in the catalogue. */
export function blockedIds(career) {
  const blocked = blockFilter(career);
  return id => Boolean(blocked({ id }));
}

/** Enforce current blocks against an ID, fresh platform metadata, or an exact saved advert/application URL. */
export function assertJobNotBlocked(career, id, metadata = null) {
  if (!savedEntries(career).length) return;
  const blocked = blockFilter(career);
  let entry = blocked({ id }) ?? blocked(metadata);
  if (!entry && metadata && [metadata.url, metadata.applyUrl, metadata.originalUrl, ...(metadata.aliases ?? [])].some(Boolean)) {
    const stores = [career.jobs, career.matching?.jobs];
    for (const store of stores) {
      for (const [savedId, saved] of Object.entries(store ?? {})) {
        const job = { ...saved, id: savedId };
        const candidate = blocked(job);
        if (candidate && sameApplicationJob(job, metadata)) { entry = candidate; break; }
      }
      if (entry) break;
    }
    if (!entry) for (const app of Object.values(career.applications ?? {})) {
      const candidate = blocked(app.job);
      if (candidate && sameApplicationJob(app.job, metadata)) { entry = candidate; break; }
    }
  }
  if (entry) fail('JOB_BLOCKED', `This job is blocked by your ${entry.kind} block (${entry.label ?? entry.value}). Remove the block in the companion before continuing. Saved drafts are unchanged.`);
}

/** Every saved job ID the companion can show: catalogue and local captures. */
function savedJobIds(career) {
  return new Set([
    ...[career.matching?.jobs, career.jobs].flatMap(store => record(store) ? Object.keys(store) : []),
    ...Object.values(career.applications ?? {}).map(app => app.job?.id),
  ].filter(id => typeof id === 'string' && !forbidden.has(id)));
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
  const existing = savedEntries(career).find(([, entry]) => entry.kind === kind &&
    (kind === 'job' ? entry.value === value : blockKey(entry.value) === blockKey(value)));
  if (existing) return { id: existing[0], ...existing[1] };
  if (!Object.hasOwn(saved, entryId)) saved[entryId] = { kind, value,
    label: kind === 'job' ? [job.title, job.company].filter(Boolean).join(' — ') || job.id : value, createdAt: new Date().toISOString() };
  return { id: entryId, ...saved[entryId] };
}

export function removeBlock(career, id) {
  if (typeof id !== 'string' || forbidden.has(id) || !record(career.blocklist) || !Object.hasOwn(career.blocklist, id))
    fail('NOT_FOUND', 'This block was already removed. Refresh the list.');
  delete career.blocklist[id];
}
