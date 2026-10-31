import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createJobTools, importCapturedJobs } from '../src/mcp/job-tools.mjs';
import { createApplicationTools } from '../src/mcp/application-tools.mjs';
import { createMatchingTools } from '../src/mcp/matching-tools.mjs';
import { createCareerBrowser } from '../src/career-browser.mjs';
import { createCareerState } from '../src/mcp/state.mjs';
import { ASSESSMENT_POLICY_ID } from '../src/mcp/matching-contract.mjs';
import { publicationInWindow } from '../src/mcp/publication-range.mjs';
import { addBlock, removeBlock } from '../src/mcp/blocklist.mjs';
import { saveAppliedJobs } from '../src/application-workflow.mjs';

const sourceUrl = 'https://jobs.example.test/search';
const full = (suffix = 'a', overrides = {}) => ({ title: 'Reporting engineer', company: 'Example',
  description: 'Build reporting services. Maintain the production service and work with customers.',
  url: `https://jobs.example.test/jobs/${suffix}`, applyUrl: `https://apply.example.test/application?job=${suffix}`,
  complete: true, ...overrides });
const row = id => ({ id, status: 'assessed', requirements: [{ requirement: 'Build reporting services', importance: 'essential',
  evidence: 'demonstrated', cvQuote: 'Built reporting services.' }],
  gates: { direction: 'pass', constraints: 'pass', eligibility: 'pass' },
  dimensions: { direction: 80, capability: 80, scope: 80, preferences: 80 }, relocation: 'not_required', reason: 'Directly supported experience.' });
function fixture(platformImpl) {
  const career = createCareerState();
  career.profile.headline = 'Reporting engineer';
  Object.assign(career.profile.preferences, { willingToRelocate: false, careerPaths: [{ name: 'Reporting engineering', titles: ['Reporting engineer'], why: 'Built reporting services.' }], locations: ['Dublin'], workModes: ['remote'], travel: 'none' });
  career.sources.cv = { purpose: 'cv', archived: false, text: 'Built reporting services.' };
  let state = { career }, queue = Promise.resolve();
  const calls = [];
  const store = { get: () => structuredClone(state), update(change) {
    const result = queue.then(async () => { const next = structuredClone(state); await change(next); state = next; });
    queue = result.catch(() => {});
    return result;
  } };
  const platform = async (operation, args) => {
    calls.push({ operation, args });
    if (!platformImpl) throw Object.assign(new Error('Feed access is not available.'), { code: 'SUBSCRIPTION_REQUIRED' });
    return platformImpl(operation, args);
  };
  const tools = new Map([...createJobTools({ store }), ...createApplicationTools({ store, platform }),
    ...createMatchingTools({ store, platform })].map(tool => [tool.name, tool]));
  const call = (name, args = {}) => tools.get(name).invoke(args);
  const mutation = () => ({ requestId: randomUUID(), revision: store.get().career.revision });
  const capture = (jobs, extra = {}) => importCapturedJobs({ store, ...mutation(), sourceUrl, jobs, ...extra });
  return { store, calls, call, mutation, capture, browser: createCareerBrowser({ store }) };
}
const rejects = (promise, code) => assert.rejects(promise, error => error.code === code);

test('native capture validates jobs and URLs atomically, without relying on MCP schemas', async () => {
  const f = fixture();
  for (const input of [full('a', { url: 'javascript:alert(1)' }), full('a', { applyUrl: 'https://user:secret@example.test/job' }),
    full('a', { url: 'https://example.test/a\n' }), full('a', { complete: 'true' }), full('a', { description: '' }),
    full('a', { title: 123 }), full('a', { publishedAt: 'yesterday' }), full('a', { publishedAt: '2026-02-30' }),
    full('a', { extra: 'not allowed' })]) {
    await rejects(f.capture([full('valid'), input]), 'INVALID_INPUT');
    assert.equal(f.store.get().career.revision, 0);
    assert.equal(f.store.get().career.jobs, undefined);
  }
  await rejects(f.capture([full()], { sourceUrl: 'file:///private/data' }), 'INVALID_INPUT');
  await rejects(f.capture(Array.from({ length: 51 }, (_, i) => full(String(i)))), 'INVALID_INPUT');
  await rejects(f.capture(Array.from({ length: 12 }, (_, i) => full(String(i), { description: 'x'.repeat(100000) }))), 'INVALID_INPUT');
  await rejects(f.capture([full()], { revision: 1 }), 'REVISION_CONFLICT');
  await rejects(f.capture([full()], { requestId: 'not-a-uuid' }), 'INVALID_INPUT');
});

test('Save as applied records each saved job as one applied application and re-saving reuses it', async () => {
  const f = fixture();
  const save = jobs => saveAppliedJobs({ store: f.store, ...f.mutation(), sourceUrl, jobs });
  const first = await save([full('a'), full('b', { complete: false, description: undefined })]);
  assert.equal(first.added, 2); assert.equal(first.revision, f.store.get().career.revision);
  const apps = () => Object.values(f.store.get().career.applications);
  assert.deepEqual(apps().map(app => app.job.id).sort(), first.jobs.map(job => job.id).sort());
  const today = new Date().toISOString().slice(0, 10);
  for (const app of apps()) assert.deepEqual(app.progress, { stage: 'applied', history: [{ stage: 'applied', at: today }] });
  // A later step the user recorded is never reset by saving the same job again.
  const interviewing = { stage: 'interviewing', round: 1, history: [{ stage: 'applied', at: today }, { stage: 'interviewing', round: 1, at: today }] };
  const id = apps().find(app => app.job.id === first.jobs[0].id).id;
  await f.store.update(state => { state.career.applications[id].progress = structuredClone(interviewing); });
  await save([full('a'), full('b', { complete: false, description: undefined })]);
  assert.equal(apps().length, 2);
  assert.deepEqual(f.store.get().career.applications[id].progress, interviewing);
});

test('batch capture receipts replay exact requests and reject changed retries', async () => {
  const f = fixture();
  const args = { store: f.store, ...f.mutation(), sourceUrl, jobs: [full('a'), full('b')] };
  const result = await importCapturedJobs(args);
  assert.equal(result.added, 2);
  assert.equal(result.updated, 0);
  assert.equal(result.revision, 1);
  assert.deepEqual(await importCapturedJobs(args), result);
  await rejects(importCapturedJobs({ ...args, jobs: [full('a')] }), 'REQUEST_CONFLICT');
  assert.equal(f.store.get().career.revision, 1);
  assert.equal(f.store.get().career.version, 2);
});

test('job URL aliases deduplicate tracking variants but preserve meaningful query identity and complete originals', async () => {
  const f = fixture();
  const first = await f.capture([full('a', { applyUrl: 'https://apply.example.test/application?job=a&utm_source=chrome#top' })]);
  const id = first.jobs[0].id;
  assert.match(id, /^local:[0-9a-f]{64}$/);
  const recaptured = await f.capture([{ title: 'Short listing', url: 'https://jobs.example.test/jobs/a?utm_medium=list#details',
    description: 'Snippet only', complete: false }]);
  assert.equal(recaptured.jobs[0].id, id);
  assert.equal(recaptured.updated, 1);
  const original = await f.call('career_job_read', { id });
  assert.equal(original.description, full().description);
  assert.equal(original.complete, true);
  assert.equal(original.title, full().title);
  const alias = await f.capture([full('elsewhere', { url: 'https://apply.example.test/application?job=a&fbclid=tracking', applyUrl: undefined })]);
  assert.equal(alias.jobs[0].id, id);
  const distinct = await f.capture([full('b')]);
  assert.notEqual(distinct.jobs[0].id, id);
  const jobs = await f.call('career_jobs');
  assert.equal(jobs.total, 2);
  assert.equal(jobs.jobs.find(job => job.id === id).publishedAt, null);
  assert.equal(f.calls.length, 0);
});

test('a shared listing source never collapses separate jobs; aliases can join previously separate captures', async () => {
  const f = fixture();
  const first = await f.capture([{ title: 'A', url: 'https://jobs.example.test/a', complete: false },
    { title: 'B', url: 'https://jobs.example.test/b', complete: false }]);
  assert.equal(first.jobs.length, 2);
  const detail = await f.capture([full('a', { url: 'https://jobs.example.test/a', applyUrl: 'https://ats.example.test/a' })]);
  assert.equal(detail.jobs[0].id, first.jobs[0].id);
  const second = await f.capture([full('b', { url: 'https://jobs.example.test/b', applyUrl: 'https://ats.example.test/b' })]);
  assert.equal(second.jobs[0].id, first.jobs[1].id);
  assert.equal((await f.call('career_jobs')).total, 2);
  const bridge = await f.capture([full('a', { url: 'https://jobs.example.test/a', applyUrl: 'https://ats.example.test/b' })]);
  assert.equal(bridge.jobs.length, 1);
  assert.equal((await f.call('career_jobs')).total, 1);
});

test('a capture source is provenance only, even when one selected complete job shares another job source', async () => {
  for (const [firstUrl, secondUrl] of [
    [sourceUrl, 'https://jobs.example.test/jobs/b'],
    ['https://jobs.example.test/jobs/a', sourceUrl],
  ]) {
    const f = fixture();
    const first = await f.capture([full('a', { url: firstUrl })]);
    const second = await f.capture([full('b', { url: secondUrl, title: 'Unrelated job', description: 'A different original advert.' })]);
    assert.notEqual(first.jobs[0].id, second.jobs[0].id);
    assert.equal(second.added, 1);
    assert.equal(second.updated, 0);
    assert.equal((await f.call('career_jobs')).total, 2);
    assert.equal((await f.call('career_job_read', { id: first.jobs[0].id })).description, full().description);
    assert.equal((await f.call('career_job_read', { id: second.jobs[0].id })).description, 'A different original advert.');
  }
});

test('listing captures are readable in Jobs but cannot be used as full originals', async () => {
  const f = fixture();
  const captured = await f.capture([{ title: 'Unknown employer role', url: 'https://jobs.example.test/unknown', description: 'A short card', complete: false }]);
  const id = captured.jobs[0].id;
  const listing = await f.call('career_jobs');
  assert.equal(listing.jobs[0].status, 'needs_full_advert');
  assert.equal(listing.jobs[0].company, null);
  assert.equal(listing.jobs[0].publishedAt, null);
  const list = await f.browser.list({ kind: 'jobs' });
  assert.deepEqual(list.items[0].card, { title: 'Unknown employer role', company: null, logoUrl: null, publishedAt: null, facts: [],
    stage: 'open', label: null, established: false, score: null, stale: false });
  const detail = await f.browser.read({ kind: 'jobs', id });
  assert.equal(detail.sections.find(section => section.heading === 'Captured listing text').text, 'A short card');
  const original = await f.call('career_job_read', { id });
  assert.equal(original.complete, false);
  assert.equal(original.company, null);
  await rejects(f.call('career_application_create', { ...f.mutation(), jobId: id }), 'FULL_AD_REQUIRED');
  const context = await f.call('career_match_jobs', { localOnly: true });
  assert.deepEqual(context.jobIds, []);
  await rejects(f.call('career_match_batch', { ids: [id] }), 'FULL_AD_REQUIRED');
  await rejects(f.call('career_match_save', { profileVersion: context.profileVersion, policyId: ASSESSMENT_POLICY_ID, assessments: [row(id)] }), 'FULL_AD_REQUIRED');
  assert.equal(f.calls.length, 0);
});

test('complete imports work offline end to end before assessment, without invented dates or feed access', async () => {
  const f = fixture();
  const captured = await f.capture([full('a', { company: undefined }), full('old', { publishedAt: '2020-01-01' })]);
  const [id, oldId] = captured.jobs.map(job => job.id);
  const initial = await f.browser.list({ kind: 'jobs' });
  assert.equal(initial.total, 2);
  assert.ok(initial.items.every(item => item.card.score === null && item.card.stage === 'open'));
  const detail = await f.browser.read({ kind: 'jobs', id });
  assert.equal(detail.sections.find(section => section.heading === 'Original advert').text, full().description);
  const app = await f.call('career_application_create', { ...f.mutation(), jobId: id });
  assert.equal(app.job.id, id);
  assert.equal(app.job.company, null);
  assert.equal(app.job.description, full().description);
  const application = await f.call('career_application_context', { applicationId: app.applicationId });
  assert.equal(application.job.id, id);
  const context = await f.call('career_match_jobs', { localOnly: true });
  assert.deepEqual(new Set(context.jobIds), new Set([id, oldId]));
  const batch = await f.call('career_match_batch', { ids: [id, oldId] });
  assert.equal(batch.jobs.length, 2);
  assert.equal(batch.jobs.find(job => job.id === id).publishedAt, null);
  assert.equal(batch.jobs[0].ad, full().description);
  await f.call('career_match_save', { profileVersion: context.profileVersion, policyId: context.policyId, assessments: [row(id), row(oldId)] });
  const ranked = await f.call('career_recommendations');
  assert.equal(ranked.total, 2);
  assert.ok(ranked.recommendations.every(job => job.overall === 80));
  assert.equal((await f.call('career_rerank_pairs')).pairs.length, 1);
  const reviewedCard = (await f.browser.list({ kind: 'jobs' })).items[0].card;
  assert.equal(reviewedCard.score, 80);
  assert.equal(reviewedCard.stage, 'reviewed');
  const refreshed = await f.call('career_match_jobs', { localOnly: true, refresh: true });
  assert.equal(refreshed.total, 2);
  assert.equal((await f.call('career_jobs')).total, 2);
  await f.call('career_rankings_delete');
  assert.equal((await f.call('career_jobs')).total, 2);
  assert.equal((await f.browser.list({ kind: 'jobs' })).total, 2);
  assert.equal((await f.call('career_job_read', { id })).description, full().description);
  assert.equal(f.calls.length, 0);
  await rejects(f.call('career_match_jobs'), 'SUBSCRIPTION_REQUIRED');
  assert.equal(f.calls.length, 1);
  assert.equal((await f.call('career_jobs')).total, 2);
});

test('default matching discovery includes imports, but platform jobs retain feed publication restrictions', async () => {
  const platformJob = { id: 'node:recent', title: 'Recent role', company: 'Platform employer', publishedAt: new Date(Date.now() - 60000).toISOString() };
  const staleJob = { ...platformJob, id: 'node:old', publishedAt: '2020-01-01' };
  const f = fixture(async (operation, args) => {
    if (operation === 'matching_catalogue') {
      const publicationWindow = { range: args.publicationRange, since: args.since, until: args.until };
      const jobs = [platformJob, staleJob].filter(job => publicationInWindow(job.publishedAt, publicationWindow));
      return { jobs, total: jobs.length, nextOffset: null, publicationWindow };
    }
    assert.equal(operation, 'matching_jobs');
    assert.deepEqual(args.ids, ['node:recent']);
    return { jobs: [{ ...platformJob, ad: 'Complete platform original' }], remainingIds: [], unavailableIds: [] };
  });
  const id = (await f.capture([full()])).jobs[0].id;
  const context = await f.call('career_match_jobs');
  assert.deepEqual(new Set(context.jobIds), new Set(['node:recent', id]));
  const batch = await f.call('career_match_batch', { ids: [id, 'node:recent'] });
  assert.equal(batch.jobs.length, 2);
  assert.equal(f.calls.length, 2);
  await rejects(f.call('career_match_batch', { ids: ['node:old'] }), 'UNKNOWN_JOB');
});

test('recapturing changed originals invalidates their assessments, while a snippet cannot downgrade them', async () => {
  const f = fixture();
  const id = (await f.capture([full()])).jobs[0].id;
  const context = await f.call('career_match_jobs', { localOnly: true });
  await f.call('career_match_save', { profileVersion: context.profileVersion, policyId: context.policyId, assessments: [row(id)] });
  await f.capture([{ title: 'Short card', url: full().url, description: 'Snippet', complete: false }]);
  assert.equal((await f.call('career_recommendations')).total, 1);
  const afterSnippet = await f.call('career_match_jobs', { localOnly: true });
  assert.equal(afterSnippet.profileVersion, context.profileVersion);
  await f.capture([full('a', { description: 'Changed remit requiring other work.' })]);
  assert.equal((await f.call('career_recommendations')).total, 0);
  assert.equal((await f.call('career_job_read', { id })).description, 'Changed remit requiring other work.');
  await rejects(f.call('career_match_save', {
    profileVersion: context.profileVersion, policyId: context.policyId, assessments: [row(id)],
  }), 'PROFILE_CHANGED');
  assert.equal((await f.call('career_recommendations')).total, 0);
  const current = await f.call('career_match_jobs', { localOnly: true });
  assert.notEqual(current.profileVersion, context.profileVersion);
  assert.equal(current.jobIds[0], id);
  await f.call('career_match_save', {
    profileVersion: current.profileVersion, policyId: current.policyId,
    assessments: [{ ...row(id), reason: 'A new judgment of the recaptured original.' }],
  });
  assert.equal((await f.call('career_recommendations')).total, 1);
});

test('local listing, read, import receipts and draft creation all honor company and direct job blocks', async () => {
  const f = fixture();
  const args = { ...f.mutation(), sourceUrl, jobs: [full('slug', { company: 'flow-traders' }),
    full('display', { company: 'Flow Traders' }), full('direct'), full('allowed')] };
  const imported = await f.call('career_job_import', args);
  const [slug, display, direct, allowed] = imported.jobs.map(job => job.id);
  const created = await f.call('career_application_create', { ...f.mutation(), jobId: direct });
  const saved = f.store.get().career.applications[created.applicationId];
  let company;
  await f.store.update(state => {
    company = addBlock(state.career, { id: slug, kind: 'company' });
    addBlock(state.career, { id: direct, kind: 'job' });
  });
  const listed = await f.call('career_jobs');
  assert.deepEqual(listed.jobs.map(job => job.id), [allowed]);
  assert.equal(listed.total, 1);
  assert.equal(listed.nextOffset, null);
  for (const id of [slug, display, direct]) {
    await rejects(f.call('career_job_read', { id }), 'JOB_BLOCKED');
    await rejects(f.call('career_application_create', { ...f.mutation(), jobId: id }), 'JOB_BLOCKED');
  }
  await rejects(f.call('career_job_import', args), 'JOB_BLOCKED');
  await rejects(f.capture([full('new', { company: 'FLOW_TRADERS' })]), 'JOB_BLOCKED');
  await rejects(f.capture([{ title: 'Recaptured listing', url: full('direct').url, complete: false }]), 'JOB_BLOCKED');
  await rejects(f.call('career_application_create', { ...f.mutation(), job: {
    title: 'Pasted role', company: 'Another display', description: 'Full advert', url: full('direct').url,
  } }), 'JOB_BLOCKED');
  assert.equal(Object.keys(f.store.get().career.jobs).length, 4);
  assert.deepEqual(f.store.get().career.applications[created.applicationId], saved);
  assert.equal((await f.call('career_job_read', { id: allowed })).id, allowed);
  assert.equal((await f.call('career_application_create', { ...f.mutation(), jobId: allowed })).job.id, allowed);
  await f.store.update(state => { removeBlock(state.career, company.id); });
  assert.equal((await f.call('career_jobs')).total, 3);
  assert.equal((await f.call('career_job_read', { id: display })).company, 'Flow Traders');
});
