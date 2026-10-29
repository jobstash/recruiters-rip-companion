import test from 'node:test';
import assert from 'node:assert/strict';
import { createCareerState, hash } from '../src/mcp/state.mjs';
import { createIntroductionTools } from '../src/mcp/introduction-tools.mjs';

const pdf = Buffer.from('%PDF-1.7 synthetic cv bytes').toString('base64');
function fixture({ share = async () => ({ documentId: 'doc-1', attached: true, employment: 2 }), platform = async () => ({ results: [] }) } = {}) {
  const career = createCareerState();
  career.sources.cv = { id: 'cv', name: 'Jane Doe CV.pdf', purpose: 'cv', archived: false, mediaType: 'application/pdf',
    originalBase64: pdf, text: 'Senior Engineer, Example Labs, 2021–2024.', contentHash: hash('Senior Engineer, Example Labs, 2021–2024.') };
  let state = { career };
  const store = { get: () => structuredClone(state), update: async change => { const next = structuredClone(state); await change(next); state = next; } };
  const calls = { platform: [], share: [], github: 0 };
  const tools = new Map(createIntroductionTools({ store,
    platform: async (operation, args) => { calls.platform.push({ operation, args }); return platform(operation, args); },
    shareCv: async body => { calls.share.push(body); return share(body); },
    openGithub: async () => { calls.github++; },
  }).map(tool => [tool.name, tool]));
  const call = (name, args = {}) => tools.get(name).invoke(args);
  return { store, calls, call, set: change => change(state.career) };
}
const role = (overrides = {}) => ({ ref: 'profile:12', name: 'Example Labs', title: 'Senior Engineer', startDate: '2021-03', endDate: '2024-01', current: false, ...overrides });
const statusOf = async f => (await f.call('career_employment_status')).sources[0].status;

test('a CV moves from needs_extraction to shared under standing consent alone, and a CV or role change needs a new share', async () => {
  const f = fixture();
  const { contentHash } = (await f.call('career_employment_status')).sources[0];
  assert.equal(await statusOf(f), 'needs_extraction');
  await f.call('career_employment_save', { sourceId: 'cv', contentHash, employment: [role(), role({ ref: 'organization:7', name: 'Second Co', title: 'Engineer', startDate: '2019', endDate: null, current: true })] });
  assert.equal(await statusOf(f), 'ready_to_share');
  await assert.rejects(f.call('career_cv_share', { sourceId: 'cv' }), { code: 'CONSENT_REQUIRED' });
  await f.call('career_introductions_update', { consent: true });
  const result = await f.call('career_cv_share', { sourceId: 'cv' });
  assert.deepEqual([result.shared, result.documentId, result.roles], [true, 'doc-1', 2]);
  const sent = f.calls.share[0];
  assert.deepEqual(sent.document, { filename: 'Jane Doe CV.pdf', mediaType: 'application/pdf', contentBase64: pdf });
  assert.deepEqual(sent.employment.map(item => Object.keys(item).sort()), [['current', 'endDate', 'ref', 'startDate', 'title'], ['current', 'endDate', 'ref', 'startDate', 'title']]);
  assert.equal(sent.consent.version, 1);
  assert.equal(sent.consent.grantedAt, (await f.call('career_employment_status')).consent.at);
  assert.equal(await statusOf(f), 'shared');
  // Re-saving different roles needs a new share; a changed CV needs a new extraction.
  await f.call('career_employment_save', { sourceId: 'cv', contentHash, employment: [role()] });
  assert.equal(await statusOf(f), 'ready_to_share');
  f.set(career => { career.sources.cv.text = 'Updated CV'; career.sources.cv.contentHash = hash('Updated CV'); });
  assert.equal(await statusOf(f), 'needs_extraction');
  await assert.rejects(f.call('career_cv_share', { sourceId: 'cv' }), { code: 'EXTRACTION_REQUIRED' });
  await assert.rejects(f.call('career_employment_save', { sourceId: 'cv', contentHash, employment: [] }), { code: 'CV_CHANGED' });
});

test('withdrawn consent sends nothing; granting again re-enables sharing', async () => {
  const f = fixture();
  const { contentHash } = (await f.call('career_employment_status')).sources[0];
  await f.call('career_employment_save', { sourceId: 'cv', contentHash, employment: [role()] });
  await f.call('career_introductions_update', { consent: true });
  await f.call('career_introductions_update', { consent: false });
  assert.deepEqual((await f.call('career_employment_status')).consent.granted, false);
  await assert.rejects(f.call('career_cv_share', { sourceId: 'cv' }), { code: 'CONSENT_REQUIRED' });
  assert.equal(f.calls.share.length, 0);
  assert.equal(await statusOf(f), 'ready_to_share');
  await f.call('career_introductions_update', { consent: true });
  assert.equal((await f.call('career_cv_share', { sourceId: 'cv' })).shared, true);
  assert.equal(f.calls.share.length, 1);
});

test('saved roles must use search refs, ordered partial dates and an open end for current roles', async () => {
  const f = fixture();
  const { contentHash } = (await f.call('career_employment_status')).sources[0];
  const save = employment => f.call('career_employment_save', { sourceId: 'cv', contentHash, employment });
  for (const invalid of [[role({ ref: 'Example Labs' })], [role({ ref: 'company:1' })], [role({ current: true })],
    [role({ startDate: '2024-05', endDate: '2023-01' })], [role({ startDate: '2021-13' })], [role({ startDate: null })], [role({ title: ' ' })], [role(), role()]])
    await assert.rejects(save(invalid), { code: 'INVALID_INPUT' });
  await assert.rejects(f.call('career_employment_save', { sourceId: 'missing', contentHash, employment: [] }), { code: 'UNKNOWN_SOURCE' });
  // A year-only range inside one year is valid, as is an ongoing role with only a start year.
  assert.equal((await save([role({ startDate: '2021', endDate: '2021' }), role({ title: 'Lead', startDate: '2024', endDate: null, current: true })])).saved, 2);
});

test('a pasted text CV is shared as text without control characters or path separators in its name', async () => {
  const f = fixture();
  f.set(career => { Object.assign(career.sources.cv, { name: 'cv/pasted', mediaType: 'text/plain', originalBase64: undefined, text: 'Engineer\fat Example\u0000Labs\nLine two' }); });
  const { contentHash } = (await f.call('career_employment_status')).sources[0];
  await f.call('career_employment_save', { sourceId: 'cv', contentHash, employment: [role()] });
  await f.call('career_introductions_update', { consent: true });
  await f.call('career_cv_share', { sourceId: 'cv' });
  assert.deepEqual(f.calls.share[0].document, { filename: 'cv-pasted', mediaType: 'text/plain', text: 'Engineer at Example Labs\nLine two' });
});

test('employer search and intro paths relay through the platform; GitHub onboarding records the opened page or a skip', async () => {
  const f = fixture();
  await f.call('career_employer_search', { queries: [{ name: 'Example Labs', website: 'example.com' }] });
  assert.deepEqual(f.calls.platform, [{ operation: 'employer_search', args: { queries: [{ name: 'Example Labs', website: 'example.com' }] } }]);
  await assert.rejects(f.call('career_employer_search', { queries: [] }), { code: 'INVALID_INPUT' });
  assert.deepEqual(await f.call('career_intro_paths', { jobIds: ['node:1'] }), { results: [] });
  assert.deepEqual(f.calls.platform[1], { operation: 'intro_paths', args: { jobIds: ['node:1'] } });
  await assert.rejects(f.call('career_intro_paths', { jobIds: ['local:abc'] }), { code: 'INVALID_INPUT' });
  await assert.rejects(f.call('career_intro_paths', { jobIds: Array.from({ length: 11 }, (_, i) => `node:${i + 1}`) }), { code: 'INVALID_INPUT' });
  await assert.rejects(f.call('career_intro_paths', {}), { code: 'INVALID_INPUT' });
  assert.equal(f.calls.platform.length, 2);
  assert.equal((await f.call('career_employment_status')).github, null);
  await f.call('account_github_connect');
  assert.equal(f.calls.github, 1);
  assert.equal((await f.call('career_employment_status')).github, 'requested');
  await f.call('career_introductions_update', { githubSkipped: true });
  assert.equal((await f.call('career_employment_status')).github, 'skipped');
});


test('introduction paths reject blocked company and job IDs without calling the platform', async () => {
  const f = fixture();
  f.set(career => {
    career.matching = { jobs: { 'node:1': { company: 'Flow Traders' }, 'node:2': { company: 'Other Company' }, 'node:3': { company: 'Allowed Company' } } };
    career.blocklist = { company: { kind: 'company', value: 'flow-traders' }, direct: { kind: 'job', value: 'node:2' } };
  });
  for (const id of ['node:1', 'node:2'])
    await assert.rejects(f.call('career_intro_paths', { jobIds: [id] }), { code: 'JOB_BLOCKED' });
  assert.deepEqual(f.calls.platform, []);
  assert.deepEqual(await f.call('career_intro_paths', { jobIds: ['node:3'] }), { results: [] });
  assert.equal(f.calls.platform.length, 1);
});

test('introduction paths are not released when their job is blocked while loading', async () => {
  let release, started;
  const waiting = new Promise(resolve => { started = resolve; });
  const response = new Promise(resolve => { release = resolve; });
  const f = fixture({ platform: async () => { started(); return response; } });
  const pending = f.call('career_intro_paths', { jobIds: ['node:1'] });
  await waiting;
  f.set(career => { career.blocklist = { direct: { kind: 'job', value: 'node:1' } }; });
  release({ results: [{ jobId: 'node:1', paths: [] }] });
  await assert.rejects(pending, { code: 'JOB_BLOCKED' });
});
