import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createCareerState } from '../src/mcp/state.mjs';
import { createMatchingTools } from '../src/mcp/matching-tools.mjs';
import { createProfileTools } from '../src/mcp/profile-tools.mjs';

function fixture() {
  let state = { career: createCareerState() }, queue = Promise.resolve();
  state.career.profile.headline = 'Engineering manager';
  state.career.profile.preferences = { willingToRelocate: false };
  state.career.sources.cv = { purpose: 'cv', text: 'Led product delivery at Acme.' };
  const applicationId = randomUUID();
  const job = { id: 'node:role', title: 'Engineering Manager', company: 'Example Employer', description: 'Lead product engineers and develop engineering managers.', publishedAt: new Date().toISOString() };
  state.career.applications[applicationId] = { id: applicationId, job };
  const store = {
    get: () => structuredClone(state),
    update(change) {
      const work = queue.then(async () => { const next = structuredClone(state); await change(next); state = next; });
      queue = work.catch(() => {}); return work;
    },
  };
  const tools = new Map([
    ...createProfileTools({ store }),
    ...createMatchingTools({ store, platform: async operation => {
      assert.equal(operation, 'matching_catalogue'); return { jobs: [job], total: 1 };
    } }),
  ].map(tool => [tool.name, tool]));
  return { store, applicationId, call: (name, args = {}) => tools.get(name).invoke(args) };
}

test('listing-specific answers invalidate old scores and reach the next evaluation with the original question and explanation', async () => {
  const f = fixture();
  const initial = await f.call('career_match_jobs');
  assert.equal(initial.candidate.facts.length, 0, 'CV-only matching must work before interviews');
  const score = { id: 'node:role', score: 70, decision: 'recommend', relocation: 'not_required', reason: 'Initial host assessment from the CV.' };
  await f.call('career_match_save', { profileVersion: initial.profileVersion, scores: [score] });
  assert.equal((await f.call('career_recommendations')).total, 1);

  const question = 'Have you directly managed engineering managers?';
  const interview = await f.call('career_interview_ask', { applicationId: f.applicationId, questions: [
    { subject: 'Managing engineering managers', prompt: question, kind: 'capability', context: 'The role includes developing engineering managers.' },
  ] });
  const partial = await f.call('career_interview_answer', { interviewId: interview.interviewId, reply: '1a' });
  assert.deepEqual(partial.unanswered, [1]);
  assert.equal((await f.call('career_recommendations')).total, 0, 'prior recommendation is stale as soon as the candidate answers');
  const explanation = 'At Acme I managed two engineering managers, set their team goals and coached them through hiring and performance reviews.';
  await f.call('career_interview_answer', { interviewId: interview.interviewId, reply: explanation });

  await assert.rejects(f.call('career_match_save', { profileVersion: initial.profileVersion, scores: [score] }), { code: 'PROFILE_CHANGED' });
  const updated = await f.call('career_match_jobs');
  assert.notEqual(updated.profileVersion, initial.profileVersion);
  assert.deepEqual(updated.jobIds, ['node:role']);
  const fact = updated.candidate.facts.find(item => item.subject === 'Managing engineering managers');
  assert.equal(fact.question, question);
  assert.equal(fact.detail, explanation);
  assert.equal(fact.followUps[0].answer, explanation);
  assert.ok(fact.context.includes('developing engineering managers'));
  // The host authors a new judgment; tools must not auto-generate a score bonus.
  assert.equal(f.store.get().career.matching.scores['node:role'].score, 70);
  await f.call('career_match_save', { profileVersion: updated.profileVersion, scores: [{ ...score, score: 88, reason: 'Reassessed by the host using the newly described management scope.' }] });
  assert.equal((await f.call('career_recommendations')).recommendations[0].score, 88);
});
