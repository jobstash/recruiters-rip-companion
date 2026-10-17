import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, readFile, writeFile, chmod, stat, symlink, mkdir, rename } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createCareerState, fail } from '../src/mcp/state.mjs';
import { createScopedAccess } from '../src/mcp/scope.mjs';
import { createProfileTools } from '../src/mcp/profile-tools.mjs';
import { createMcpServer, createPlatformTools } from '../src/mcp/server.mjs';
import { createDocumentFiles, readSelectedSource } from '../src/mcp/files.mjs';
import { createMatchingTools } from '../src/mcp/matching-tools.mjs';
import { ASSESSMENT_POLICY_ID, deriveDecision } from '../src/mcp/matching-contract.mjs';

const scoredAt = '2026-10-14T12:00:00.000Z';
function storedAssessment(id, overall, changes = {}) {
  const row = { id, status: 'assessed',
    requirements: [{ requirement: 'Own production services', importance: 'essential', evidence: 'demonstrated', cvQuote: 'Built services.' }],
    gates: { direction: 'pass', constraints: 'pass', eligibility: 'pass' },
    dimensions: { direction: overall, capability: overall, scope: overall, preferences: overall },
    relocation: 'not_required', reason: 'Saved full-advert review.', ...changes };
  return { ...row, ...deriveDecision(row), profileVersion: '0:0', policyId: ASSESSMENT_POLICY_ID, scoredAt, host: { name: 'host', version: '1' } };
}

function fixture() {
  let state = { deviceId: randomUUID(), career: createCareerState(), pairing: { account: { id: 'first-owner' } } }, queue = Promise.resolve(), epoch = 0, locked = false;
  const store = { get: () => structuredClone(state), update(change) { const work = queue.then(async () => { const next = structuredClone(state); await change(next); state = next; }); queue = work.catch(() => {}); return work; } };
  const available = () => { if (locked) fail('LOCAL_LOCKED', 'Local storage is locked.'); };
  const scoped = createScopedAccess(store, { assertAvailable: available, epoch: () => epoch });
  return { store, scoped, lock() { locked = true; }, reset() { epoch++; state = { deviceId: randomUUID(), career: createCareerState(), pairing: { account: { id: 'second-owner' } } }; }, lockAndUnlock() { epoch++; } };
}

test('a delayed local file import cannot enter a reset identity with the same revision', async () => {
  const f = fixture(); let release, started;
  const fetching = new Promise(resolve => { started = resolve; });
  const response = new Promise(resolve => { release = resolve; });
  const tools = createProfileTools({ store: f.scoped.store,
    selectSourceFile: async () => { started(); return response; },
    extractFile: async () => ({ text: 'Private previous owner' }) });
  const pending = tools.find(tool => tool.name === 'career_source_import').invoke({ requestId: randomUUID(), revision: 0, method: 'file' });
  await fetching; f.reset(); release({ buffer: Buffer.from('Private previous owner'), originalname: 'CV.txt', mimetype: 'text/plain' });
  await assert.rejects(pending, { code: 'IDENTITY_CHANGED' });
  assert.deepEqual(f.store.get().career.sources, {}); assert.equal(f.store.get().career.revision, 0);
});

test('locking rejects an in-progress mutation before its encrypted transaction can publish', async () => {
  const f = fixture(); let release, began;
  const started = new Promise(resolve => { began = resolve; }); const resume = new Promise(resolve => { release = resolve; });
  const pending = f.scoped.store.update(async state => { state.career.profile.name = 'Not committed'; began(); await resume; });
  await started; f.lock(); release();
  await assert.rejects(pending, { code: 'LOCAL_LOCKED' }); assert.equal(f.store.get().career.profile.name, null);
  assert.throws(() => f.scoped.store.get(), { code: 'LOCAL_LOCKED' });
});

test('a previous socket stays invalid after lock and unlock even if the identity is unchanged', () => {
  const f = fixture(); f.lockAndUnlock(); assert.throws(() => f.scoped.store.get(), { code: 'IDENTITY_CHANGED' });
});

test('MCP denies arbitrary fields and hides filesystem paths in tool and resource errors', async t => {
  const f = fixture(), directory = await mkdtemp(path.join(os.tmpdir(), 'mcp-disclosure-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const privatePath = path.join(directory, 'private-source-does-not-exist.pdf');
  const tools = createProfileTools({ store: f.scoped.store, selectSourceFile: () => readSelectedSource(privatePath), extractFile: () => assert.fail('Missing file must not be parsed') });
  const files = createDocumentFiles({ directory, store: f.scoped.store, assertAvailable: f.scoped.assertAvailable });
  const server = createMcpServer({ tools, assertAvailable: f.scoped.assertAvailable, readResource: files.readResource, listResources: files.listResources });
  const client = new Client({ name: 'boundary-consumer', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport); await client.connect(clientTransport);
  t.after(async () => { await client.close(); await server.close(); });
  const rejected = await client.callTool({ name: 'career_profile_update', arguments: { requestId: randomUUID(), revision: 0, patch: { name: 'Candidate' }, apiKey: 'must-not-be-accepted' } });
  assert.equal(rejected.isError, true); assert.equal(JSON.parse(rejected.content[0].text).error.code, 'INVALID_INPUT'); assert.equal(f.store.get().career.revision, 0);
  const missing = await client.callTool({ name: 'career_source_import', arguments: { requestId: randomUUID(), revision: 0, method: 'file' } });
  assert.equal(missing.isError, true); assert.equal(JSON.parse(missing.content[0].text).error.code, 'LOCAL_OPERATION_FAILED'); assert.equal(JSON.stringify(missing).includes(directory), false);
  await assert.rejects(client.readResource({ uri: `recruiters://exports/${'a'.repeat(64)}.pdf` }), error => !error.message.includes(directory) && /export is unavailable/.test(error.message));
  await assert.rejects(client.readResource({ uri: `file://${privatePath}` }), error => !error.message.includes(privatePath));
});

test('locked storage allows protocol initialization but no private read until native unlock', async t => {
  let locked = true, reads = 0;
  const state = { deviceId: randomUUID(), career: createCareerState() };
  state.career.profile.name = 'Private candidate';
  const store = { get() { reads++; return structuredClone(state); }, update() { assert.fail('Read-only scenario must not write'); } };
  const scoped = createScopedAccess(store, { assertAvailable() { if (locked) fail('LOCAL_LOCKED', 'Unlock local storage in the companion.'); }, epoch: () => 0 });
  const server = createMcpServer({ tools: createProfileTools({ store: scoped.store }), assertAvailable: scoped.assertAvailable,
    readResource: () => assert.fail('No resource requested'), listResources: () => [] });
  const client = new Client({ name: 'locked-storage-consumer', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport); await client.connect(clientTransport);
  t.after(async () => { await client.close(); await server.close(); });
  const denied = await client.callTool({ name: 'career_profile_read', arguments: {} });
  assert.equal(denied.isError, true);
  assert.equal(JSON.parse(denied.content[0].text).error.code, 'LOCAL_LOCKED');
  assert.equal(reads, 0);
  assert.equal(JSON.stringify(denied).includes('Private candidate'), false);
  locked = false;
  const allowed = await client.callTool({ name: 'career_profile_read', arguments: {} });
  assert.equal(JSON.parse(allowed.content[0].text).profile.name, 'Private candidate');
});

test('complete CSV export uses native MCP resources alongside existing PDF exports without platform access', async t => {
  const f = fixture(), directory = await mkdtemp(path.join(os.tmpdir(), 'mcp-ranking-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await f.store.update(state => {
    state.career.profile.preferences.willingToRelocate = false;
    state.career.matching = { jobs: {}, scores: {
      'node:ny': storedAssessment('node:ny', 88, { relocation: 'required', reason: 'New York office required' }),
      'node:compatible': storedAssessment('node:compatible', 79, { reason: 'Compatible location but unsuitable scope',
        requirements: [{ requirement: 'Own production services', importance: 'essential', evidence: 'contradicted' }] }),
      'node:unclear': { ...storedAssessment('node:unclear', 95, { relocation: 'unclear', reason: 'Needs location confirmation' }), policyId: 'earlier-policy' },
      'node:older': { ...storedAssessment('node:older', 90, { relocation: 'required', reason: 'Excluded,\nnot recommended',
        gates: { direction: 'fail', constraints: 'pass', eligibility: 'pass' } }), profileVersion: 'old' },
      'node:missing': { id: 'node:missing', status: 'unavailable', reason: 'Ad unavailable', ...deriveDecision({ status: 'unavailable' }),
        profileVersion: 'old', policyId: ASSESSMENT_POLICY_ID, scoredAt, host: null },
    } };
  });
  const files = createDocumentFiles({ directory, store: f.scoped.store, assertAvailable: f.scoped.assertAvailable });
  const pdfBytes = Buffer.from('%PDF-1.4\nexisting PDF\n%%EOF');
  const pdf = await files.exportDocument({ bytes: pdfBytes, mediaType: 'application/pdf' });
  const before = f.store.get();
  const tools = createMatchingTools({ store: f.scoped.store, platform: () => assert.fail('Export must not contact platform'),
    exportDocument: files.exportDocument });
  const server = createMcpServer({ tools, assertAvailable: f.scoped.assertAvailable,
    readResource: files.readResource, listResources: files.listResources });
  const client = new Client({ name: 'ranking-consumer', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport); await client.connect(clientTransport);
  t.after(async () => { await client.close(); await server.close(); });
  const pageResponse = await client.callTool({ name: 'career_matches', arguments: {} });
  assert.notEqual(pageResponse.isError, true);
  const page = JSON.parse(pageResponse.content.find(item => item.type === 'text').text);
  assert.equal(page.total, 5); assert.equal(page.nextOffset, null);
  assert.equal(page.view, 'assessment_archive');
  assert.equal(page.reviewed, 2); assert.equal(page.needsReview, 3);
  assert.ok(page.matches.every(row => ['profileVersion', 'policyId', 'host'].every(key => !Object.hasOwn(row, key))));
  assert.deepEqual(page.matches.map(row => [row.id, row.overall, row.decision, row.matchStatus]), [
    ['node:compatible', 79, 'skip', 'eligible'], ['node:unclear', 95, 'recommend', 'needs_location_confirmation'],
    ['node:ny', 88, 'recommend', 'incompatible_location'], ['node:older', 90, 'skip', 'excluded'], ['node:missing', null, 'clarify', 'unavailable'],
  ]);
  const recommendationResponse = await client.callTool({ name: 'career_recommendations', arguments: {} });
  assert.notEqual(recommendationResponse.isError, true);
  const recommendations = JSON.parse(recommendationResponse.content.find(item => item.type === 'text').text);
  assert.deepEqual(recommendations.recommendations, []);
  assert.equal(recommendations.total, 0);
  assert.equal(recommendations.scored, 4); assert.equal(recommendations.unavailable, 1);
  assert.equal(recommendations.reviewed, 2); assert.equal(recommendations.needsReview, 3);
  const response = await client.callTool({ name: 'career_matches_export', arguments: {} });
  assert.notEqual(response.isError, true);
  const result = JSON.parse(response.content.find(item => item.type === 'text').text);
  assert.equal(result.total, 5); assert.equal(result.scored, 4); assert.equal(result.unavailable, 1);
  const link = response.content.find(item => item.type === 'resource_link');
  assert.equal(link.uri, result.export.uri); assert.equal(link.mimeType, 'text/csv');
  const csv = (await client.readResource({ uri: link.uri })).contents[0];
  assert.equal(csv.mimeType, 'text/csv');
  assert.ok(csv.text.includes('"node:older"')); assert.ok(csv.text.includes('"node:missing"'));
  assert.ok(csv.text.includes('"Excluded,\nnot recommended"'));
  const lines = csv.text.split('\r\n');
  assert.equal(lines[0], ['id', 'title', 'company', 'overall', 'band', 'direction', 'capability', 'scope', 'preferences',
    'directionGate', 'constraintsGate', 'eligibilityGate', 'publishedAt', 'salaryMinimum', 'salaryMaximum', 'salaryStated',
    'salaryCurrency', 'salaryPeriod', 'city', 'location', 'workMode', 'relocation', 'matchStatus', 'decision', 'reviewStatus',
    'pairwiseWins', 'reason', 'applyUrl'].map(column => `"${column}"`).join(','));
  assert.equal(lines.find(line => line.startsWith('"node:ny"')), ['node:ny', '', '', '88', 'strong', '88', '88', '88', '88',
    'pass', 'pass', 'pass', '', '', '', '', '', '', '', '', '', 'required', 'incompatible_location', 'recommend', 'current',
    '', 'New York office required', ''].map(value => `"${value}"`).join(','));
  assert.equal(csv.text.includes('profileVersion') || csv.text.includes('policyId') || csv.text.includes(ASSESSMENT_POLICY_ID), false);
  let previousRow = -1;
  for (const row of page.matches) {
    const rowStart = csv.text.indexOf(`"${row.id}"`);
    assert.ok(rowStart > previousRow);
    assert.ok(csv.text.slice(rowStart, csv.text.indexOf('\r\n', rowStart)).includes(`"${row.matchStatus}"`));
    previousRow = rowStart;
  }
  assert.equal(csv.text, await readFile(result.export.path, 'utf8'));
  assert.equal((await stat(result.export.path)).mode & 0o777, 0o600);
  assert.equal((await stat(path.dirname(result.export.path))).mode & 0o777, 0o700);
  const legacy = (await client.readResource({ uri: pdf.uri })).contents[0];
  assert.equal(legacy.mimeType, 'application/pdf');
  assert.deepEqual(Buffer.from(legacy.blob, 'base64'), pdfBytes);
  assert.deepEqual(new Set((await client.listResources()).resources.map(item => item.mimeType)), new Set(['application/pdf', 'text/csv']));
  assert.deepEqual(f.store.get(), before);
  f.reset();
  await assert.rejects(files.readResource(result.export.uri), { code: 'IDENTITY_CHANGED' });
  const newFiles = createDocumentFiles({ directory, store: f.store, assertAvailable: () => {} });
  assert.deepEqual(await newFiles.listResources(), []);
  await assert.rejects(newFiles.readResource(result.export.uri), { code: 'ENOENT' });
});

test('document exports reject corrupt bytes, changed permissions, symlinks and arbitrary resource paths', async t => {
  const f = fixture(), directory = await mkdtemp(path.join(os.tmpdir(), 'mcp-export-safety-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const files = createDocumentFiles({ directory, store: f.scoped.store, assertAvailable: f.scoped.assertAvailable });
  for (const [mediaType, bytes] of [['text/html', Buffer.from('private')],
    ['text/plain', Buffer.from([0xff, 0xfe])], ['text/csv', Buffer.from([0xff, 0xfe])], ['application/pdf', Buffer.from('not a PDF')],
    ['text/plain', Buffer.alloc(0)], ['text/csv', Buffer.alloc(0)], ['text/csv', Buffer.alloc(12 * 1024 * 1024 + 1)]])
    await assert.rejects(files.exportDocument({ mediaType, bytes }), { code: 'INVALID_INPUT' });
  const csvBytes = Buffer.from('"id","reason"\r\n"node:a","Société"\r\n');
  const csv = await files.exportDocument({ mediaType: 'text/csv', bytes: csvBytes });
  assert.deepEqual(await files.exportDocument({ mediaType: 'text/csv', bytes: csvBytes }), csv);
  for (const uri of [`file://${csv.path}`, 'recruiters://exports/../../secret.csv',
    `recruiters://exports/${csv.sha256}.docx`, `recruiters://exports/${csv.sha256}.csv?path=secret`,
    `recruiters://exports/%2e%2e/${csv.sha256}.csv`])
    await assert.rejects(files.readResource(uri), { code: 'NOT_FOUND' });
  await chmod(csv.path, 0o644);
  await assert.rejects(files.readResource(csv.uri), { code: 'EXPORT_CORRUPT' });
  await chmod(csv.path, 0o600);
  await writeFile(csv.path, Buffer.from('"tampered"\r\n'));
  await assert.rejects(files.readResource(csv.uri), { code: 'EXPORT_CORRUPT' });
  await assert.rejects(files.exportDocument({ mediaType: 'text/csv', bytes: csvBytes }), { code: 'EXPORT_CORRUPT' });
  await rm(csv.path);
  const privateSource = path.join(directory, 'private-source.csv');
  await writeFile(privateSource, csvBytes, { mode: 0o600 });
  await symlink(privateSource, csv.path);
  await assert.rejects(files.readResource(csv.uri), error => ['ELOOP', 'EMLINK'].includes(error.code));
  await rm(csv.path);
  await files.exportDocument({ mediaType: 'text/csv', bytes: csvBytes });
  await chmod(files.exportDirectory(), 0o755);
  await assert.rejects(files.readResource(csv.uri), { code: 'EXPORT_CORRUPT' });
  await assert.rejects(files.listResources(), { code: 'EXPORT_CORRUPT' });
  await chmod(files.exportDirectory(), 0o700);
  const displaced = path.join(directory, 'displaced-exports');
  await rename(files.exportDirectory(), displaced);
  await symlink(displaced, files.exportDirectory());
  await assert.rejects(files.readResource(csv.uri), { code: 'EXPORT_CORRUPT' });
  await assert.rejects(files.listResources(), { code: 'EXPORT_CORRUPT' });
  await assert.rejects(files.exportDocument({ mediaType: 'text/csv', bytes: csvBytes }));
});

test('export ancestor symlinks and malformed device identities cannot redirect private resources', async t => {
  const f = fixture(), directory = await mkdtemp(path.join(os.tmpdir(), 'mcp-export-root-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const outside = path.join(directory, 'outside');
  await mkdir(outside, { mode: 0o700 });
  await symlink(outside, path.join(directory, 'career-files'));
  const files = createDocumentFiles({ directory, store: f.scoped.store, assertAvailable: f.scoped.assertAvailable });
  await assert.rejects(files.exportDocument({ mediaType: 'text/csv', bytes: Buffer.from('"id"\r\n') }));
  await assert.rejects(files.listResources(), { code: 'EXPORT_CORRUPT' });
  await f.store.update(state => { state.deviceId = '../../outside'; });
  const malformed = createDocumentFiles({ directory, store: f.store, assertAvailable: () => {} });
  await assert.rejects(malformed.exportDocument({ mediaType: 'text/csv', bytes: Buffer.from('"id"\r\n') }), { code: 'EXPORT_CORRUPT' });
  await assert.rejects(malformed.listResources(), { code: 'EXPORT_CORRUPT' });
});

test('plain-text CV resources retain Unicode and enforce private-file integrity', async t => {
  const f = fixture(), directory = await mkdtemp(path.join(os.tmpdir(), 'mcp-txt-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const files = createDocumentFiles({ directory, store: f.scoped.store, assertAvailable: f.scoped.assertAvailable });
  const text = 'Zoë Candidate\nzoe@example.test\n\nExpérience\n• Built reliable services.\n';
  const exported = await files.exportDocument({ mediaType: 'text/plain', bytes: Buffer.from(text) });
  assert.match(exported.uri, /^recruiters:\/\/exports\/[a-f0-9]{64}\.txt$/);
  const resource = await files.readResource(exported.uri);
  assert.equal(resource.text, text);
  assert.equal(resource.mimeType, 'text/plain');
  assert.equal((await stat(exported.path)).mode & 0o777, 0o600);
  assert.ok((await files.listResources()).some(resource => resource.uri === exported.uri && resource.mimeType === 'text/plain'));
  await writeFile(exported.path, 'Tampered CV');
  await assert.rejects(files.readResource(exported.uri), { code: 'EXPORT_CORRUPT' });
});

test('preference mutations reject invalid identifiers without writes and recover with an issued UUID', async t => {
  const f = fixture();
  const server = createMcpServer({
    tools: [...createProfileTools({ store: f.scoped.store }), ...createPlatformTools({ store: f.scoped.store })],
    assertAvailable: f.scoped.assertAvailable,
    readResource: () => assert.fail('No resource requested'), listResources: () => [],
  });
  const client = new Client({ name: 'preference-contract-consumer', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport); await client.connect(clientTransport);
  t.after(async () => { await client.close(); await server.close(); });
  const call = (name, args = {}) => client.callTool({ name, arguments: args });
  const body = response => JSON.parse(response.content[0].text);
  const before = f.store.get();
  const invalid = await call('career_preferences_update', {
    requestId: 'private-descriptive-request-label', revision: 0, patch: { directReports: 'required' },
  });
  assert.equal(invalid.isError, true);
  assert.equal(body(invalid).error.code, 'INVALID_INPUT');
  assert.ok(body(invalid).error.message.includes('request_id'));
  assert.equal(body(invalid).error.message.includes('private-descriptive-request-label'), false);
  assert.deepEqual(f.store.get(), before);
  const missing = await call('career_preferences_update', { patch: { directReports: 'required' } });
  assert.equal(missing.isError, true);
  assert.deepEqual(f.store.get(), before);

  const issued = body(await call('request_id'));
  const current = body(await call('career_profile_read'));
  const patch = { directReports: 'required', responsibilityModes: ['managerial'], notes: 'Prefer a team-owned delivery remit; specialist operations may be secondary, not the primary work.' };
  const saved = await call('career_preferences_update', { requestId: issued.requestId, revision: current.revision, patch });
  assert.notEqual(saved.isError, true);
  const readback = body(await call('career_profile_read'));
  assert.deepEqual(readback.preferences, patch);
  assert.notEqual(readback.matchingProfileVersion, current.matchingProfileVersion);
  assert.deepEqual(readback.profile, current.profile);
});
