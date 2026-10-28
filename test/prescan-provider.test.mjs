import test from 'node:test';
import assert from 'node:assert/strict';
import { decisionProviders, getDecisionProvider } from '../src/prescan/providers.mjs';
import { CAREER_DIRECTION_POLICY, COMPETENCY_POLICY, SALARY_POLICY } from '../src/mcp/matching-contract.mjs';

const provider = getDecisionProvider('openai');
const input = { apiKey: 'sk-test-provider-key-1234567890', candidate: { preferences: { desiredRole: 'Chosen direction' }, career: 'Complete career evidence' }, job: { id: 'one', ad: 'Full original job advert', company: { name: 'Employer' } } };
const labels = ['Poor', 'Weak', 'Partial', 'Strong', 'Excellent'];
const choices = ['direction', 'constraints', 'eligibility', 'location'], scores = ['direction_fit', 'capability_fit', 'scope_fit', 'preferences_fit'];
const levels = [3, 4, 2, 1];
const distribution = probabilities => labels.map((label, value) => ({ label, value, probability: probabilities[value] }));
const mean = probabilities => probabilities.reduce((sum, probability, value) => sum + probability * value, 0);
function responseData() {
  return { model: 'gpt-6-luna', usage: { input_tokens: 123 }, answers: [
    ...choices.map((name, index) => ({ name, type: 'choice', choice: 'aligned', confidence: [0.8, 0.7, 0.6, 0.9][index], probabilities: [
      { value: 'aligned', probability: 0.8 }, { value: 'uncertain', probability: 0.15 }, { value: 'conflict', probability: 0.05 },
    ] })),
    ...scores.map((name, index) => ({ name, type: 'score', score: levels[index], confidence: 0.9,
      probabilities: distribution(labels.map((label, value) => value === levels[index] ? 1 : 0)) })),
  ] };
}
const jsonResponse = data => new Response(JSON.stringify(data), { status: 200 });
const assess = data => provider.assess({ ...input, fetchImpl: async () => jsonResponse(data) });

test('fixed registry and documented direct Decisions wire shape preserve complete evidence', async () => {
  assert.equal(Object.isFrozen(decisionProviders), true);
  assert.equal(Object.isFrozen(provider), true);
  for (const id of ['jev', '__proto__', 'https://evil.invalid']) assert.throws(() => getDecisionProvider(id), { code: 'PRESCAN_UNSUPPORTED_PROVIDER' });
  let calls = 0;
  const result = await provider.assess({ ...input, fetchImpl: async (url, options) => {
    calls++;
    assert.equal(url, 'https://api.openai.com/v1/decisions');
    assert.equal(options.method, 'POST'); assert.equal(options.redirect, 'error');
    assert.equal(options.headers.Authorization, `Bearer ${input.apiKey}`);
    assert.ok(options.signal instanceof AbortSignal);
    const body = JSON.parse(options.body);
    assert.equal(body.model, 'gpt-6-luna');
    assert.deepEqual(JSON.parse(body.input[1].content), { candidate: input.candidate, job: input.job });
    for (const policy of [CAREER_DIRECTION_POLICY, COMPETENCY_POLICY, SALARY_POLICY]) assert.ok(body.input[0].content.includes(policy));
    assert.deepEqual(body.questions.map(({ name, type }) => ({ name, type })),
      [...choices.map(name => ({ name, type: 'choice' })), ...scores.map(name => ({ name, type: 'score' }))]);
    // Location has its own gate; the other gates no longer adjudicate it, so a location veto can never be a salary conflict.
    assert.match(body.questions[3].instructions, /worksite and work mode/);
    assert.match(body.questions[1].instructions, /other than location/);
    for (const question of body.questions.slice(4)) {
      assert.deepEqual(question.levels.map(level => level.label), labels);
      assert.match(question.instructions, /^Preliminary: /);
    }
    return jsonResponse({ ...responseData(), extra: input.apiKey });
  } });
  // Certain Strong / Excellent / Partial / Weak → expected levels ¾ / 1 / ½ / ¼, weighted .30/.25/.15/.30 = .625, softened by
  // each gate's 5% conflict (×0.975 four times).
  assert.equal(calls, 1); assert.deepEqual(result.dimensions, { direction: 75, capability: 100, scope: 50, preferences: 25 });
  assert.ok(Math.abs(result.fit - 100 * 0.975 ** 4 * 0.625) < 1e-9); assert.equal(result.priority, 56); assert.equal(result.confidence, 0.6);
  assert.equal(result.conflictProbability, 0.05); assert.equal(result.locationConflict, 0.05);
  assert.deepEqual([result.direction, result.constraints, result.eligibility, result.location], ['aligned', 'aligned', 'aligned', 'aligned']);
  assert.match(provider.policyId, /^[0-9a-f]{16}$/);
  assert.equal(result.inputTokens, 123); assert.equal(result.status, 'scored');
  assert.deepEqual(result.answers, responseData().answers);
  assert.equal(JSON.stringify(result).includes(input.apiKey), false);
});

test('refusal is explicit and cannot produce a score or explanation', async () => {
  const data = responseData(); data.answers[0] = { name: 'direction', type: 'refusal', refusal: input.apiKey };
  const result = await assess(data);
  assert.equal(result.status, 'refused'); assert.equal(result.priority, null); assert.equal(result.fit, null); assert.equal(result.confidence, null);
  assert.equal(result.dimensions, null); assert.equal(result.eligibility, null); assert.equal(result.location, null); assert.equal(result.locationConflict, null);
  assert.deepEqual(result.answers[0], { name: 'direction', type: 'refusal' });
});

test('priority is the expected level of the full distribution, never the mode, softened by every gate conflict so the list keeps spread', async () => {
  const cases = [
    // [distribution, expected level as a share]: a Poor/Excellent coin flip is half credit, a 60% Excellent is 75, mostly Weak is 28 — not 0.
    [[0.5, 0, 0, 0, 0.5], 50], [[0.1, 0.1, 0.1, 0.1, 0.6], 75], [[0.2, 0.2, 0.2, 0.2, 0.2], 50], [[0.1, 0.7, 0.2, 0, 0], 28],
  ];
  for (const [probabilities, share] of cases) {
    const data = responseData();
    for (const answer of data.answers.slice(4)) { answer.probabilities = distribution(probabilities); answer.score = mean(probabilities); }
    for (const answer of data.answers.slice(0, 4)) answer.probabilities = [{ value: 'aligned', probability: 1 }, { value: 'uncertain', probability: 0 }, { value: 'conflict', probability: 0 }];
    const result = await assess(data);
    assert.deepEqual(result.dimensions, { direction: share, capability: share, scope: share, preferences: share });
    assert.equal(result.priority, share); assert.equal(result.conflictProbability, 0);
  }
  // Every gate softens the score by half its conflict probability; uncertain mass never counts. The reported conflict is the largest.
  const data = responseData();
  data.answers[1].probabilities = [{ value: 'aligned', probability: 0.3 }, { value: 'uncertain', probability: 0.3 }, { value: 'conflict', probability: 0.4 }];
  data.answers[2].probabilities = [{ value: 'aligned', probability: 0 }, { value: 'uncertain', probability: 0.9 }, { value: 'conflict', probability: 0.1 }];
  const discounted = await assess(data);
  assert.equal(discounted.conflictProbability, 0.4); assert.equal(discounted.priority, 45);
  assert.ok(Math.abs(discounted.fit - 100 * 0.975 * 0.8 * 0.95 * 0.975 * 0.625) < 1e-9);
  // A certain direction conflict halves the score instead of zeroing it: the job ranks low but still ranks.
  const certain = responseData();
  certain.answers[0].choice = 'conflict';
  certain.answers[0].probabilities = [{ value: 'aligned', probability: 0 }, { value: 'uncertain', probability: 0 }, { value: 'conflict', probability: 1 }];
  const halved = await assess(certain);
  assert.equal(halved.status, 'scored'); assert.equal(halved.priority, 29);
});

test('only a near-certain predicted location conflict vetoes the job; below that it weighs like any other gate', async () => {
  for (const [conflict, status, priority] of [[0.49, 'scored', 44], [0.5, 'scored', 43], [0.84, 'scored', 34], [0.85, 'incompatible_location'], [0.9, 'incompatible_location']]) {
    const data = responseData();
    data.answers[3].choice = conflict >= 0.5 ? 'conflict' : 'aligned';
    data.answers[3].probabilities = [{ value: 'aligned', probability: Number((1 - conflict).toFixed(2)) }, { value: 'uncertain', probability: 0 }, { value: 'conflict', probability: conflict }];
    const result = await assess(data);
    assert.equal(result.status, status); assert.equal(result.locationConflict, conflict);
    if (status === 'scored') { assert.equal(result.conflictProbability, Math.max(conflict, 0.05)); assert.equal(result.priority, priority); }
    else { assert.equal(result.priority, null); assert.equal(result.fit, null); assert.equal(result.dimensions, null); assert.equal(result.location, 'conflict'); }
  }
});

test('invalid response shapes fail closed', async () => {
  const changes = [
    data => { data.model = 'other'; }, data => { data.answers.pop(); }, data => { data.answers.splice(4); },
    data => { data.answers[1].name = 'direction'; }, data => { data.answers[0].choice = true; },
    data => { data.answers[0].confidence = 2; }, data => { data.answers[0].probabilities[0].probability = 0; },
    data => { data.answers[0].probabilities[1].value = 'aligned'; }, data => { data.answers[4].probabilities[0].label = 'injected'; },
    data => { data.answers[4].score = 4.1; }, data => { data.answers[4].score = 1; }, data => { data.answers[2].type = 'score'; },
    data => { data.answers[4].probabilities[0].value = 0.5; }, data => { data.usage.input_tokens = -1; },
    data => { data.usage.input_tokens = 1.5; }, data => { data.usage.input_tokens = Number.MAX_SAFE_INTEGER + 1; },
  ];
  for (const change of changes) { const data = responseData(); change(data); await assert.rejects(assess(data), { code: 'PRESCAN_INVALID_RESPONSE' }); }
});

test('HTTP failures are safely classified with no retry or body disclosure', async () => {
  for (const [status, code] of [[401, 'PRESCAN_AUTH'], [403, 'PRESCAN_AUTH'], [429, 'PRESCAN_RATE_LIMIT'], [500, 'PRESCAN_PROVIDER_ERROR'], [302, 'PRESCAN_PROVIDER_ERROR']]) {
    let calls = 0;
    await assert.rejects(provider.assess({ ...input, fetchImpl: async () => { calls++; return new Response(input.apiKey, { status }); } }), cause => {
      assert.equal(cause.code, code); assert.equal(cause.message.includes(input.apiKey), false); return true;
    });
    assert.equal(calls, 1);
  }
});

test('network, redirect and timeout errors are redacted', async () => {
  for (const [name, code] of [['TypeError', 'PRESCAN_NETWORK'], ['TimeoutError', 'PRESCAN_TIMEOUT']]) {
    await assert.rejects(provider.assess({ ...input, fetchImpl: async () => { throw Object.assign(new Error(input.apiKey), { name }); } }), cause => {
      assert.equal(cause.code, code); assert.equal(cause.message.includes(input.apiKey), false); return true;
    });
  }
});

test('abort before dispatch and during fetch prevents further work', async () => {
  const controller = new AbortController(); controller.abort(new Error(input.apiKey));
  await assert.rejects(provider.assess({ ...input, signal: controller.signal, fetchImpl: () => assert.fail('must not dispatch') }), { code: 'PRESCAN_CANCELLED' });
  const active = new AbortController();
  await assert.rejects(provider.assess({ ...input, signal: active.signal, fetchImpl: async () => { active.abort(new Error(input.apiKey)); return new Promise(() => {}); } }), { code: 'PRESCAN_CANCELLED' });
});

test('oversized UTF-8 input and invalid keys never dispatch', async () => {
  await assert.rejects(provider.assess({ ...input, job: { ad: 'é'.repeat(120000) }, fetchImpl: () => assert.fail('must not dispatch') }), { code: 'PRESCAN_INPUT_TOO_LARGE' });
  for (const apiKey of ['Bearer token', 'eyJ.fake.jwt', `${input.apiKey}\n`, ` ${input.apiKey}`]) {
    await assert.rejects(provider.assess({ ...input, apiKey, fetchImpl: () => assert.fail('must not dispatch') }), { code: 'PRESCAN_INVALID_KEY' });
  }
});

test('bounded response rejects declared and streaming oversized bodies and malformed JSON', async () => {
  for (const response of [new Response('x', { headers: { 'content-length': String(1024 * 1024 + 1) } }), new Response('x'.repeat(1024 * 1024 + 1)), new Response('{')]) {
    await assert.rejects(provider.assess({ ...input, fetchImpl: async () => response }), { code: 'PRESCAN_INVALID_RESPONSE' });
  }
});
