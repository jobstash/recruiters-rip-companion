import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ASSESSMENT_POLICY_ID, BANDS, CAREER_DIRECTION_POLICY, COMPETENCY_POLICY, DIMENSION_WEIGHTS, MATCHING_PROTOCOL,
  MATCHING_TOOL_DESCRIPTIONS, RECOMMEND_MINIMUM, RERANK_POLICY, RERANK_SIZE, SALARY_POLICY, assessmentSchema,
  comparisonSchema, policyIdFor,
} from '../src/mcp/matching-contract.mjs';
import { SKILL_DIGEST } from '../src/generated/skill-digest.mjs';

test('the assessment policy ID is a 16-hex fingerprint of the complete matching contract', () => {
  const parts = protocol => ({
    protocol, policies: [CAREER_DIRECTION_POLICY, COMPETENCY_POLICY, SALARY_POLICY],
    weights: DIMENSION_WEIGHTS, bands: BANDS, recommendMinimum: RECOMMEND_MINIMUM, rerankSize: RERANK_SIZE,
    assessmentSchema, comparisonSchema, rerankPolicy: RERANK_POLICY, descriptions: MATCHING_TOOL_DESCRIPTIONS, skill: SKILL_DIGEST,
  });
  assert.match(ASSESSMENT_POLICY_ID, /^[0-9a-f]{16}$/);
  assert.equal(policyIdFor(parts(MATCHING_PROTOCOL)), ASSESSMENT_POLICY_ID);
  assert.notEqual(policyIdFor(parts([...MATCHING_PROTOCOL, 'An additional rubric rule.'])), ASSESSMENT_POLICY_ID);
});
