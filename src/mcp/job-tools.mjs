import { createHash } from 'node:crypto';
import { fail, mutateCareer, mutationSchema, readCareer } from './state.mjs';

const object = (properties, required = Object.keys(properties)) => ({ type: 'object', properties, required, additionalProperties: false });
const text = maxLength => ({ type: 'string', minLength: 1, maxLength, pattern: '\\S' });
export const capturedJobSchema = object({ title: text(300), company: text(300), description: text(100000),
  url: text(2000), applyUrl: text(2000), publishedAt: text(80), location: text(300), complete: { type: 'boolean' } }, ['title', 'url', 'complete']);
const captureProperties = { sourceUrl: text(2000), jobs: { type: 'array', items: capturedJobSchema, minItems: 1, maxItems: 50 } };
const tracking = /^(?:utm_.+|gclid|dclid|fbclid|msclkid|mc_cid|mc_eid)$/i;
const own = (value, key) => Object.hasOwn(value, key);
function assertObject(value, allowed) {
  if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
      Reflect.ownKeys(value).some(key => !allowed.includes(key))) fail('INVALID_INPUT', `Provide only ${allowed.join(', ')}.`);
}
function string(value, field, maximum, optional = false) {
  if (optional && value === undefined) return;
  if (typeof value !== 'string' || !value.trim() || value.length > maximum || value.includes('\0'))
    fail('INVALID_INPUT', `${field} must be nonempty text of at most ${maximum} characters.`);
}
/** URL identity keeps application/query identity, dropping only fragments and known tracking parameters. */
export function canonicalJobUrl(value) {
  string(value, 'URL', 2000);
  let url;
  try { url = new URL(value); } catch { fail('INVALID_INPUT', 'Use an absolute HTTP(S) job URL.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || /[\s\u0000-\u001f\u007f]/u.test(value))
    fail('INVALID_INPUT', 'Use an HTTP(S) job URL without credentials or whitespace.');
  url.hash = '';
  for (const key of [...url.searchParams.keys()]) if (tracking.test(key)) url.searchParams.delete(key);
  url.searchParams.sort();
  return url.href;
}
function validateCapture(sourceUrl, jobs) {
  const source = canonicalJobUrl(sourceUrl);
  if (!Array.isArray(jobs) || !jobs.length || jobs.length > 50) fail('INVALID_INPUT', 'Capture between one and fifty jobs.');
  const normalized = jobs.map((job, index) => {
    assertObject(job, Object.keys(capturedJobSchema.properties));
    for (const [key, maximum] of [['title', 300], ['company', 300], ['description', 100000], ['location', 300]])
      string(job[key], `jobs[${index}].${key}`, maximum, key !== 'title');
    if (typeof job.complete !== 'boolean' || (job.complete && !job.description?.trim()))
      fail('INVALID_INPUT', 'A complete job needs the full advert description; listing snippets must use complete:false.');
    if (job.publishedAt !== undefined) {
      string(job.publishedAt, 'publishedAt', 80);
      if (!/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2}))?$/.test(job.publishedAt) ||
          !Number.isFinite(Date.parse(job.publishedAt)) || new Date(job.publishedAt.slice(0, 10)).toISOString().slice(0, 10) !== job.publishedAt.slice(0, 10))
        fail('INVALID_INPUT', 'publishedAt must be a real ISO date, or omitted when unknown.');
    }
    return { ...job, title: job.title.trim(), url: canonicalJobUrl(job.url),
      ...(job.applyUrl !== undefined ? { applyUrl: canonicalJobUrl(job.applyUrl) } : {}) };
  });
  if (Buffer.byteLength(JSON.stringify({ sourceUrl, jobs })) > 1024 * 1024)
    fail('INVALID_INPUT', 'A capture may contain at most 1 MiB of job data.');
  return { sourceUrl: source, jobs: normalized };
}
export function localJob(career, id) {
  return typeof id === 'string' && id.startsWith('local:') && own(career.jobs ?? {}, id) ? career.jobs[id] : null;
}
export function localJobMetadata(job) {
  return { id: job.id, title: job.title, company: job.company ?? null, publishedAt: job.publishedAt ?? null,
    url: job.url, applyUrl: job.applyUrl, sourceUrl: job.sourceUrl, location: job.location ?? null,
    complete: job.complete, imported: true, salary: null, city: null, workMode: null };
}
export function localJobOriginal(career, id, requireComplete = false) {
  const job = localJob(career, id);
  if (!job) fail('UNKNOWN_JOB', 'This local job was not found. Read career_jobs and use a saved job ID.');
  if (requireComplete && !job.complete) fail('FULL_AD_REQUIRED', 'This capture contains only a listing. Open the original job, capture its full advert and save it before assessment or application drafting.');
  return { ...localJobMetadata(job), description: job.description ?? '', ad: job.description ?? '',
    capturedAt: job.capturedAt, updatedAt: job.updatedAt };
}
export function completeLocalJobs(career) {
  return Object.values(career.jobs ?? {}).filter(job => job.complete).map(localJobMetadata);
}
const compactJob = job => ({ id: job.id, title: job.title, company: job.company ?? null, url: job.url, complete: job.complete });

export async function importCapturedJobs({ store, requestId, revision, sourceUrl, jobs }) {
  const capture = validateCapture(sourceUrl, jobs);
  // Receipts fingerprint the original request, not its canonical projection.
  return mutateCareer(store, { requestId, revision }, 'career_job_import', { sourceUrl, jobs }, career => {
    const saved = career.jobs ??= {};
    const previousIds = new Set(Object.keys(saved));
    const imported = new Map();
    let originalsChanged = false;
    for (const input of capture.jobs) {
      const aliases = new Set([input.url, input.applyUrl ?? input.url]);
      // The page a capture came from is provenance, not proof that two job URLs identify the same role.
      const matches = Object.values(saved).filter(job =>
        (job.aliases ?? [job.url, job.applyUrl]).some(url => aliases.has(url)));
      const existing = matches[0];
      const id = existing?.id ?? `local:${createHash('sha256').update(input.applyUrl ?? input.url).digest('hex')}`;
      const stamp = new Date().toISOString();
      const base = existing ?? { id, capturedAt: stamp, company: null, location: null, publishedAt: null, description: '', complete: false };
      for (const match of matches) for (const alias of match.aliases ?? [match.url, match.applyUrl]) if (alias) aliases.add(alias);
      // If aliases bridge two older captures, retain the complete original and migrate references.
      const original = matches.find(job => job.complete) ?? base;
      const accept = input.complete || !original.complete;
      const job = { ...base, ...original,
        ...(accept ? { title: input.title, company: input.company ?? original.company, location: input.location ?? original.location,
          publishedAt: input.publishedAt ?? original.publishedAt, description: input.description ?? original.description,
          url: input.url, applyUrl: input.applyUrl ?? original.applyUrl ?? input.url, complete: input.complete,
          sourceUrl: capture.sourceUrl } : {}),
        id, aliases: [...aliases], sourceUrls: [...new Set([...matches.flatMap(job => job.sourceUrls ?? [job.sourceUrl]).filter(Boolean), capture.sourceUrl])], updatedAt: stamp };
      const changed = existing && ['title', 'company', 'location', 'publishedAt', 'description', 'complete'].some(key => existing[key] !== job[key]);
      if (changed) {
        originalsChanged = true;
        if (career.matching?.scores) delete career.matching.scores[id];
        for (const [key, pair] of Object.entries(career.matching?.pairs ?? {})) if (pair.a === id || pair.b === id) delete career.matching.pairs[key];
      }
      for (const duplicate of matches.slice(1)) {
        delete saved[duplicate.id];
        imported.delete(duplicate.id);
        if (career.matching) {
          delete career.matching.jobs?.[duplicate.id];
          delete career.matching.scores?.[duplicate.id];
          for (const [key, pair] of Object.entries(career.matching.pairs ?? {})) if ([pair.a, pair.b].includes(duplicate.id)) delete career.matching.pairs[key];
        }
        for (const app of Object.values(career.applications ?? {})) if (app.job.id === duplicate.id) app.job.id = id;
      }
      saved[id] = job;
      if (career.matching?.jobs?.[id]) career.matching.jobs[id] = localJobMetadata(job);
      imported.set(id, compactJob(job));
    }
    // Workers holding an earlier original must not restore their old judgments after a recapture.
    if (originalsChanged) career.rankingVersion = (career.rankingVersion ?? 0) + 1;
    const added = [...imported.keys()].filter(id => !previousIds.has(id)).length;
    return { added, updated: imported.size - added, jobs: [...imported.values()] };
  });
}

export function createJobTools({ store }) {
  return [
    { name: 'career_job_import', description: 'Save captured jobs locally. Mark listing snippets complete:false; only complete originals can be assessed or used to draft an application. Unknown metadata must be omitted.',
      inputSchema: object({ ...mutationSchema, ...captureProperties }), readOnly: false,
      invoke(args = {}) { assertObject(args, ['requestId', 'revision', 'sourceUrl', 'jobs']); return importCapturedJobs({ store, ...args }); } },
    { name: 'career_jobs', description: 'List durable locally captured jobs, including unassessed jobs and listings that still need the full advert. Use career_job_read for captured text.',
      inputSchema: object({ limit: { type: 'integer', minimum: 1, maximum: 100 }, offset: { type: 'integer', minimum: 0 } }, []), readOnly: true,
      invoke(args = {}) {
        assertObject(args, ['limit', 'offset']);
        const { limit = 25, offset = 0 } = args;
        if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger(offset) || offset < 0) fail('INVALID_INPUT', 'Use limit 1–100 and a nonnegative integer offset.');
        const career = readCareer(store), rows = Object.values(career.jobs ?? {}).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
        const jobs = rows.slice(offset, offset + limit).map(job => ({ ...localJobMetadata(job), status: job.complete ? 'saved' : 'needs_full_advert' }));
        return { revision: career.revision, jobs, total: rows.length, nextOffset: offset + jobs.length < rows.length ? offset + jobs.length : null };
      } },
  ];
}
