// Golden-set eval harness: packets for manual inference, deterministic scoring of the replies.
// No inference runs here; models are run by a person in a fresh Codex or Claude conversation.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { createCareerState } from '../src/mcp/state.mjs';
import { DIMENSIONS, MATCHING_PROTOCOL, assessmentSchema, deriveDecision } from '../src/mcp/matching-contract.mjs';
import { candidateContext, validateCitations } from '../src/mcp/matching-tools.mjs';

export const EVAL_DIR = path.dirname(fileURLToPath(import.meta.url));
export const GOLDEN_DIR = path.join(EVAL_DIR, 'golden');
export const RUNS_DIR = path.join(EVAL_DIR, 'runs');
export const JOB_PREFIX = 'node:eval-';

/** Gated metrics: `max` metrics must not exceed it, `min` metrics must reach it. */
export const GATES = Object.freeze({
  malformedRate: { max: 0 },
  hardGateAccuracy: { min: 1 },
  decisionMacroF1: { min: 0.8 },
  pairwiseAccuracy: { min: 0.85 },
  worstSliceAccuracy: { min: 0.6 },
  twinConsistency: { min: 1 },
});
/** With a baseline, a gated metric also fails when it worsens by more than this. */
export const BASELINE_TOLERANCE = 0.02;
const EPSILON = 1e-9;
const DECISIONS = ['recommend', 'clarify', 'skip'];

const ajv = new Ajv({ strict: false, allErrors: false });
addFormats(ajv);
const validAssessment = ajv.compile(assessmentSchema);

const readJSON = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const jsonFiles = dir => fs.readdirSync(dir).filter(name => name.endsWith('.json')).sort();

/** Reads eval/golden: candidates and jobs keyed by file name, plus labels. */
export function loadGolden(dir = GOLDEN_DIR) {
  const load = sub => Object.fromEntries(jsonFiles(path.join(dir, sub)).map(name => [name.slice(0, -5), readJSON(path.join(dir, sub, name))]));
  const candidates = load('candidates'), jobs = load('jobs');
  for (const [key, candidate] of Object.entries(candidates))
    if (candidate.id !== key) throw new Error(`golden/candidates/${key}.json has id ${candidate.id}`);
  for (const [key, job] of Object.entries(jobs))
    if (job.id !== `${JOB_PREFIX}${key}`) throw new Error(`golden/jobs/${key}.json must have id ${JOB_PREFIX}${key}`);
  return { candidates, jobs, labels: readJSON(path.join(dir, 'labels.json')) };
}

/** Golden jobs in label order for one candidate. */
export const jobsFor = (golden, candidate) =>
  golden.labels.cases.filter(item => item.candidate === candidate).map(item => golden.jobs[item.job]);

/** Replaces the `__RECENT__` publishedAt placeholder with now minus one day. */
export const withPublishedAt = (job, now = Date.now()) =>
  job.publishedAt === '__RECENT__' ? { ...job, publishedAt: new Date(now - 86_400_000).toISOString() } : job;

/** A synthetic career vault for one golden candidate, as the matching tools see it. */
export function careerFor(candidate) {
  const career = createCareerState();
  career.profile = { ...career.profile, ...candidate.profile };
  career.sources = { cv: { purpose: 'cv', text: candidate.cv, archived: false } };
  career.facts = Object.fromEntries(candidate.facts.map(fact => [fact.id, { ...fact }]));
  return career;
}

const json = value => `\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``;

/** One self-contained markdown packet: rubric, output contract, candidate context and complete jobs. */
export function packetFor(candidate, jobs) {
  return [
    `# Matching eval packet: ${candidate.id}`,
    '## Rubric', MATCHING_PROTOCOL.join('\n\n'),
    '## Output contract', json(assessmentSchema),
    'Reply with only JSON {"assessments":[...]}, one per job, in any order.',
    '## Candidate', json(candidateContext(careerFor(candidate))),
    '## Jobs', json(jobs),
  ].join('\n\n') + '\n';
}

/** Reads `<dir>/manifest.json` and every `<dir>/responses/<candidate>.json`; unparsable replies become null. */
export function loadRun(dir) {
  const manifest = readJSON(path.join(dir, 'manifest.json'));
  const responsesDir = path.join(dir, 'responses');
  const responses = {};
  if (fs.existsSync(responsesDir)) for (const name of jsonFiles(responsesDir)) {
    try { responses[name.slice(0, -5)] = readJSON(path.join(responsesDir, name)); }
    catch { responses[name.slice(0, -5)] = null; }
  }
  return { manifest, responses };
}

const ratio = (hits, total) => total ? hits / total : null;
const sameDimensions = (a, b) => DIMENSIONS.every(key => a[key] === b[key]);

function macroF1(rows) {
  const scores = DECISIONS.map(decision => {
    const tp = rows.filter(row => row.expected === decision && row.decision === decision).length;
    const fp = rows.filter(row => row.expected !== decision && row.decision === decision).length;
    const fn = rows.filter(row => row.expected === decision && row.decision !== decision).length;
    return 2 * tp + fp + fn ? (2 * tp) / (2 * tp + fp + fn) : null;
  }).filter(score => score !== null);
  return scores.length ? scores.reduce((sum, score) => sum + score, 0) / scores.length : null;
}

function evaluateCase(item, response, careers) {
  const id = `${JOB_PREFIX}${item.job}`;
  const base = { candidate: item.candidate, job: item.job, id };
  if (response === undefined) return { ...base, problem: { code: 'MISSING_RESPONSE', message: `responses/${item.candidate}.json is missing.` } };
  if (!Array.isArray(response?.assessments))
    return { ...base, problem: { code: 'INVALID_RESPONSE', message: `responses/${item.candidate}.json must be JSON {"assessments":[...]}.` } };
  const matches = response.assessments.filter(row => row?.id === id);
  if (!matches.length) return { ...base, problem: { code: 'MISSING_ASSESSMENT', message: `No assessment for ${id}.` } };
  if (matches.length > 1) return { ...base, problem: { code: 'DUPLICATE_ASSESSMENT', message: `${matches.length} assessments for ${id}.` } };
  const [row] = matches;
  if (!validAssessment(row)) {
    const issue = validAssessment.errors[0];
    return { ...base, problem: { code: 'INVALID_ASSESSMENT', message: `${id}${issue.instancePath} ${issue.message}.` } };
  }
  const problem = validateCitations(careers[item.candidate], row);
  if (problem) return { ...base, problem };
  return { ...base, row, ...deriveDecision(row) };
}

/**
 * Pure scorer (no fs). `responses` is `{ [candidateId]: { assessments: [...] } }`, the parsed
 * `responses/<candidate>.json` files (null for an unparsable file, absent for a missing one).
 * `candidates` is `loadGolden().candidates`; `baseline` is an earlier report `{ policyId, metrics }`.
 * Returns `{ policyId, baselinePolicyId?, metrics, slices, malformed, failures }`.
 */
export function scoreRun(manifest, responses, labels, { candidates, baseline } = {}) {
  const careers = Object.fromEntries(Object.values(candidates).map(candidate => [candidate.id, careerFor(candidate)]));
  const rows = labels.cases.map(item => ({ ...evaluateCase(item, responses[item.candidate], careers), expected: item.decision, label: item }));
  const result = Object.fromEntries(rows.map(row => [`${row.candidate}\u0000${row.job}`, row]));
  const resultFor = (candidate, job) => result[`${candidate}\u0000${job}`];
  const valid = row => !row.problem;

  const hardCases = rows.filter(row => Object.values(row.label.gates ?? {}).includes('fail'));
  const pairScores = labels.pairs.map(({ candidate, better, worse }) => {
    const a = resultFor(candidate, better), b = resultFor(candidate, worse);
    if (!a || !b || !valid(a) || !valid(b) || a.overall === null || b.overall === null) return 0;
    return a.overall > b.overall ? 1 : a.overall === b.overall ? 0.5 : 0;
  });
  const sliceNames = [...new Set(rows.map(row => row.label.slice))].sort();
  const slices = Object.fromEntries(sliceNames.map(slice => {
    const members = rows.filter(row => row.label.slice === slice);
    const correct = members.filter(row => row.decision === row.expected).length;
    return [slice, { cases: members.length, correct, accuracy: correct / members.length }];
  }));
  const twinGroups = Object.values(Object.groupBy(rows.filter(row => row.label.twin), row => `${row.candidate}\u0000${row.label.twin}`));
  const ranges = rows.flatMap(row => Object.entries(row.label.dimensions ?? {}).map(([key, [lo, hi]]) =>
    valid(row) && row.row.status === 'assessed' && row.row.dimensions[key] >= lo && row.row.dimensions[key] <= hi ? 1 : 0));

  const metrics = {
    malformedRate: ratio(rows.filter(row => !valid(row)).length, rows.length),
    hardGateAccuracy: ratio(hardCases.filter(row => row.decision === 'skip').length, hardCases.length),
    decisionMacroF1: macroF1(rows),
    pairwiseAccuracy: ratio(pairScores.reduce((sum, value) => sum + value, 0), pairScores.length),
    worstSliceAccuracy: sliceNames.length ? Math.min(...sliceNames.map(slice => slices[slice].accuracy)) : null,
    twinConsistency: ratio(twinGroups.filter(group => group.length > 1 && group.every(row => valid(row) && row.row.status === 'assessed') &&
      group.every(row => sameDimensions(row.row.dimensions, group[0].row.dimensions))).length, twinGroups.length),
    dimensionRangeHit: ratio(ranges.reduce((sum, value) => sum + value, 0), ranges.length),
  };

  const failures = [];
  for (const [metric, { min, max }] of Object.entries(GATES)) {
    const value = metrics[metric];
    if (value === null) continue;
    if (max !== undefined && value > max + EPSILON) failures.push({ metric, value, threshold: max });
    if (min !== undefined && value < min - EPSILON) failures.push({ metric, value, threshold: min });
  }
  if (baseline) for (const [metric, { max }] of Object.entries(GATES)) {
    const value = metrics[metric], before = baseline.metrics?.[metric];
    if (value === null || typeof before !== 'number') continue;
    const threshold = max !== undefined ? before + BASELINE_TOLERANCE : before - BASELINE_TOLERANCE;
    if (max !== undefined ? value > threshold + EPSILON : value < threshold - EPSILON)
      failures.push({ metric, value, threshold, baseline: before });
  }

  return {
    policyId: manifest.policyId,
    ...(baseline ? { baselinePolicyId: baseline.policyId } : {}),
    metrics, slices,
    malformed: rows.filter(row => !valid(row)).map(({ candidate, job, problem }) => ({ candidate, job, ...problem })),
    failures,
  };
}

const format = value => value === null ? 'n/a' : value.toFixed(3);

/** Plain-text report for the terminal. */
export function formatReport(report) {
  const lines = [`policyId ${report.policyId}${report.baselinePolicyId ? ` (baseline ${report.baselinePolicyId})` : ''}`, ''];
  const failed = new Set(report.failures.filter(failure => failure.baseline === undefined).map(failure => failure.metric));
  const width = Math.max(...Object.keys(report.metrics).map(name => name.length));
  lines.push(`${'metric'.padEnd(width)}  value  gate      status`);
  for (const [metric, value] of Object.entries(report.metrics)) {
    const gate = GATES[metric], rule = !gate ? 'reported' : gate.max !== undefined ? `<= ${gate.max}` : `>= ${gate.min}`;
    lines.push(`${metric.padEnd(width)}  ${format(value).padStart(5)}  ${rule.padEnd(8)}  ${!gate ? '-' : failed.has(metric) ? 'FAIL' : 'ok'}`);
  }
  lines.push('', 'slice accuracy');
  for (const [slice, { cases, correct, accuracy }] of Object.entries(report.slices))
    lines.push(`  ${slice.padEnd(32)} ${correct}/${cases}  ${format(accuracy)}`);
  if (report.malformed.length) {
    lines.push('', 'malformed');
    for (const item of report.malformed) lines.push(`  ${item.candidate}/${item.job} ${item.code}: ${item.message}`);
  }
  lines.push('', report.failures.length ? 'FAILED' : 'PASSED');
  for (const failure of report.failures) lines.push(failure.baseline === undefined
    ? `  ${failure.metric} ${format(failure.value)} (threshold ${failure.threshold})`
    : `  ${failure.metric} ${format(failure.value)} dropped from baseline ${format(failure.baseline)} (threshold ${format(failure.threshold)})`);
  return lines.join('\n');
}
