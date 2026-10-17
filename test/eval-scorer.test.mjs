import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { EVAL_DIR, jobsFor, loadGolden, loadRun, packetFor, scoreRun } from '../eval/lib.mjs';

const golden = loadGolden();
const replay = name => loadRun(path.join(EVAL_DIR, 'fixtures', 'replay', name));
const score = (name, options = {}) => {
  const { manifest, responses } = replay(name);
  return scoreRun(manifest, responses, golden.labels, { candidates: golden.candidates, ...options });
};
const PLAN_SLICES = [
  'exact-continuation', 'manager-vs-ic', 'salary-below-minimum', 'salary-missing', 'excluded-domain',
  'foreign-office-no-relocation', 'location-only-twin', 'negative-fact',
  'deliberate-lower-scope', 'strong-skills-wrong-direction', 'ambiguous-remote', 'prompt-injection', 'long-noisy-advert',
  'deliberate-career-change', 'accepted-alternative-boundary', 'implied-capability', 'specialist-must-have-missing',
  'work-authorization', 'language-required-missing', 'language-satisfied', 'seniority-overreach',
];

test('the passing replay satisfies every gated metric', () => {
  const report = score('passing');
  assert.deepEqual(report.failures, []);
  assert.equal(report.metrics.malformedRate, 0);
  assert.deepEqual(report.malformed, []);
});

test('the regressed replay fails exactly the hard-gate, pairwise and twin metrics', () => {
  const report = score('regressed');
  assert.deepEqual(report.failures.map(failure => failure.metric).sort(), ['hardGateAccuracy', 'pairwiseAccuracy', 'twinConsistency']);
  assert.equal(report.metrics.malformedRate, 0);
  assert.ok(report.metrics.decisionMacroF1 >= 0.8);
  assert.ok(report.metrics.worstSliceAccuracy >= 0.6);
});

test('a baseline comparison additionally reports drops beyond the tolerance', () => {
  const passing = score('passing');
  const report = score('regressed', { baseline: passing });
  assert.equal(report.baselinePolicyId, 'fixture');
  const absolute = report.failures.filter(failure => failure.baseline === undefined).map(failure => failure.metric).sort();
  const drops = report.failures.filter(failure => failure.baseline !== undefined);
  assert.deepEqual(absolute, ['hardGateAccuracy', 'pairwiseAccuracy', 'twinConsistency']);
  assert.deepEqual(drops.map(failure => failure.metric).sort(),
    ['decisionMacroF1', 'hardGateAccuracy', 'pairwiseAccuracy', 'twinConsistency', 'worstSliceAccuracy']);
  for (const failure of drops) assert.ok(failure.baseline - failure.value > 0.02, failure.metric);
  assert.deepEqual(score('passing', { baseline: passing }).failures, []);
});

test('golden labels reference real candidates and jobs, cover every slice, and build packets', () => {
  const { candidates, jobs, labels } = golden;
  assert.equal(Object.keys(candidates).length, 4);
  assert.equal(labels.cases.length, 32);
  for (const item of labels.cases) {
    assert.ok(candidates[item.candidate], `unknown candidate ${item.candidate}`);
    assert.ok(jobs[item.job], `unknown job ${item.job}`);
  }
  assert.equal(new Set(labels.cases.map(item => item.job)).size, labels.cases.length);
  for (const pair of labels.pairs)
    for (const job of [pair.better, pair.worse])
      assert.ok(labels.cases.some(item => item.candidate === pair.candidate && item.job === job), `pair ${pair.candidate}/${job}`);
  for (const id of Object.keys(candidates)) {
    assert.equal(labels.cases.filter(item => item.candidate === id).length, 8, id);
    assert.ok(labels.pairs.filter(pair => pair.candidate === id).length >= 3, id);
  }
  const slices = new Set(labels.cases.map(item => item.slice));
  for (const slice of PLAN_SLICES) assert.ok(slices.has(slice), `missing slice ${slice}`);
  for (const candidate of Object.values(candidates)) {
    const packet = packetFor(candidate, jobsFor(golden, candidate.id));
    for (const heading of ['## Rubric', '## Output contract', '## Candidate', '## Jobs']) assert.ok(packet.includes(heading), heading);
    for (const job of jobsFor(golden, candidate.id)) assert.ok(packet.includes(job.id));
  }
});
