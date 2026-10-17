// pnpm eval:score <run> [--baseline <run>]: deterministic scoring of saved replies; exit 1 on any failure.
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { RUNS_DIR, formatReport, loadGolden, loadRun, scoreRun } from './lib.mjs';

const { values, positionals } = parseArgs({ options: { baseline: { type: 'string' } }, allowPositionals: true });
if (positionals.length !== 1) {
  console.error('Usage: pnpm eval:score <run> [--baseline <run>]');
  process.exit(2);
}
const golden = loadGolden();
const score = (run, options = {}) => {
  const { manifest, responses } = loadRun(path.join(RUNS_DIR, run));
  return scoreRun(manifest, responses, golden.labels, { candidates: golden.candidates, ...options });
};
const baseline = values.baseline ? score(values.baseline) : undefined;
const report = score(positionals[0], { baseline });
fs.writeFileSync(path.join(RUNS_DIR, positionals[0], 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
console.log(formatReport(report));
process.exitCode = report.failures.length ? 1 : 0;
