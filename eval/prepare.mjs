// pnpm eval:prepare [--run <name>]: writes one packet per golden candidate for manual inference. Runs no model.
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { ASSESSMENT_POLICY_ID } from '../src/mcp/matching-contract.mjs';
import { RUNS_DIR, jobsFor, loadGolden, packetFor, withPublishedAt } from './lib.mjs';

const { values } = parseArgs({ options: { run: { type: 'string' } } });
const now = new Date();
const run = values.run ?? now.toISOString().replace(/[:.]/g, '-');
if (!/^[\w.-]+$/.test(run)) throw new Error('--run may contain only letters, digits, ".", "_" and "-".');
const dir = path.join(RUNS_DIR, run);
if (fs.existsSync(dir)) throw new Error(`eval/runs/${run} already exists; choose another --run name.`);

const golden = loadGolden();
fs.mkdirSync(path.join(dir, 'packets'), { recursive: true });
fs.mkdirSync(path.join(dir, 'responses'));
const packets = Object.values(golden.candidates).map(candidate => {
  const jobs = jobsFor(golden, candidate.id).map(job => withPublishedAt(job, now.getTime()));
  const file = `packets/${candidate.id}.md`;
  fs.writeFileSync(path.join(dir, file), packetFor(candidate, jobs));
  return { file, candidate: candidate.id, jobs: jobs.map(job => job.id) };
});
fs.writeFileSync(path.join(dir, 'manifest.json'),
  `${JSON.stringify({ run, policyId: ASSESSMENT_POLICY_ID, createdAt: now.toISOString(), packets }, null, 2)}\n`);

console.log(`Wrote ${packets.length} packets to eval/runs/${run}/packets.`);
console.log(`Run each packet in a fresh Codex or Claude conversation; save the JSON reply as responses/<candidate>.json; then pnpm eval:score ${run}.`);
