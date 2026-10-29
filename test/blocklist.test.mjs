import test from 'node:test';
import assert from 'node:assert/strict';
import { addBlock, assertJobNotBlocked, blockFilter, blockedIds, blockKey, listBlocks } from '../src/mcp/blocklist.mjs';
import { createCareerState } from '../src/mcp/state.mjs';

const job = { id: 'node:1', title: 'Engineer', company: 'Flow Traders', classification: 'Smart Contracts' };
const fixture = () => ({ ...createCareerState(), matching: { jobs: { [job.id]: { ...job } }, scores: {}, pairs: {} } });

test('company and category slugs normalize like display names without merging unrelated names', () => {
  for (const value of ['Flow Traders', 'flow-traders', 'FLOW_TRADERS', '  Flow  Traders ', 'Ｆｌｏｗ－Ｔｒａｄｅｒｓ'])
    assert.equal(blockKey(value), 'flow traders');
  assert.notEqual(blockKey('Flow Traders'), blockKey('Flow Trading'));
  assert.notEqual(blockKey('AB'), blockKey('A-B'));
  const career = fixture();
  career.blocklist = { 'company:flow-traders': { kind: 'company', value: 'flow-traders', createdAt: '2026-01-01' } };
  assert.equal(blockFilter(career)(job).id, 'company:flow-traders');
  assert.equal(addBlock(career, { id: job.id, kind: 'company' }).id, 'company:flow-traders');
  assert.equal(Object.keys(career.blocklist).length, 1, 'older slug entries are reused rather than duplicated');
  career.blocklist = { 'category:smart-contracts': { kind: 'category', value: 'smart-contracts' } };
  assert.equal(blockedIds(career)(job.id), true);
  assert.equal(listBlocks(career)[0].matches, 1);
});

test('guards check fresh company objects, saved metadata and direct IDs after catalogue removal', () => {
  const career = fixture();
  addBlock(career, { id: job.id, kind: 'company' });
  assert.throws(() => assertJobNotBlocked(career, 'node:2', { company: { name: 'Flow Traders', slug: 'flow-traders' } }), { code: 'JOB_BLOCKED' });
  assert.throws(() => assertJobNotBlocked(career, 'node:2', { company: { name: 'Different Display', slug: 'flow-traders' } }), { code: 'JOB_BLOCKED' });
  assert.throws(() => assertJobNotBlocked(career, job.id, { company: 'Different fresh value' }), { code: 'JOB_BLOCKED' });
  assert.doesNotThrow(() => assertJobNotBlocked(career, 'node:2', { company: 'Another Employer' }));
  career.blocklist = {};
  addBlock(career, { id: job.id, kind: 'job' });
  delete career.matching.jobs[job.id];
  assert.equal(blockedIds(career)(job.id), true);
  assert.throws(() => assertJobNotBlocked(career, job.id), { code: 'JOB_BLOCKED' });
  assert.doesNotThrow(() => assertJobNotBlocked(career, 'node:2'));
});

test('URL-only and saved-application guards use exact ATS role identity and retain every draft', () => {
  const career = fixture(), role = 'a6bff5dd-1a4e-48ca-9421-f61fb85d1011';
  const url = `https://jobs.ashbyhq.com/example/${role}`;
  career.applications.saved = { job: { ...job, url }, cv: { version: 1, text: 'Saved draft' }, coverLetter: { version: 2 } };
  career.matching.jobs[job.id].url = url;
  addBlock(career, { id: job.id, kind: 'job' });
  delete career.matching.jobs[job.id];
  const before = structuredClone(career);
  assert.throws(() => assertJobNotBlocked(career, null, { url: `${url}/application?utm_source=test` }), { code: 'JOB_BLOCKED' });
  assert.throws(() => assertJobNotBlocked(career, job.id, career.applications.saved.job), { code: 'JOB_BLOCKED' });
  assert.doesNotThrow(() => assertJobNotBlocked(career, null, { url: `https://jobs.ashbyhq.com/example/${role.replace('1011', '1012')}/application` }));
  assert.deepEqual(career, before);
});
