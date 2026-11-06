import { execFileSync } from 'node:child_process';
import { appendFile, readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const STABLE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
export function compareStable(left, right) {
  if (!STABLE.test(left) || !STABLE.test(right)) throw new Error('Release versions must be stable major.minor.patch versions.');
  const a = left.split('.').map(Number), b = right.split('.').map(Number);
  if (![...a, ...b].every(Number.isSafeInteger)) throw new Error('Release version exceeds the supported numeric range.');
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i] ? 1 : -1;
  return 0;
}
export function shipsRuntime(name) {
  return /^(?:src\/|ui\/|browser-extension\/|skills\/|scripts\/|package\.json$|pnpm-lock\.yaml$)/.test(name);
}
export function releasePolicy({ version, previousVersion, changed }) {
  const order = compareStable(version, previousVersion);
  if (order < 0) throw new Error('The package version must not move backwards.');
  const runtimeChanged = changed.some(shipsRuntime);
  if (runtimeChanged && order <= 0) throw new Error(`Runtime or packaging changes require a package.json version greater than ${previousVersion}.`);
  return { version, publish: runtimeChanged && order > 0, runtimeChanged };
}

export async function requireReleaseSecurity({ sha, request, timeout = 5 * 60_000, pause = ms => new Promise(resolve => setTimeout(resolve, ms)), now = Date.now }) {
  if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error('Security verification requires an exact release commit.');
  const deadline = now() + timeout;
  async function pages(endpoint, field) {
    const rows = [];
    for (let page = 1; ; page++) {
      const response = await request(`${endpoint}${endpoint.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
      const values = field ? response?.[field] : response;
      if (!Array.isArray(values)) throw new Error('Security verification returned an invalid inventory.');
      rows.push(...values);
      if (values.length < 100) return rows;
      if (now() >= deadline) throw new Error('Security inventory pagination exceeded the verification deadline.');
    }
  }
  for (;;) {
    const runs = await pages(`actions/workflows/security.yml/runs?head_sha=${sha}&event=push`, 'workflow_runs');
    const run = runs.filter(value => value.head_sha === sha && value.head_branch === 'main').sort((a, b) => b.id - a.id)[0];
    if (run?.status === 'completed' && run.conclusion !== 'success') throw new Error('The exact release security workflow failed or was cancelled.');
    const analyses = await pages('code-scanning/analyses?ref=refs%2Fheads%2Fmain');
    const analysis = analyses.find(value => value.commit_sha === sha && value.ref === 'refs/heads/main' && value.tool?.name === 'CodeQL' && value.analysis_key === '.github/workflows/security.yml:codeql');
    if (analysis?.error) throw new Error('The exact release CodeQL analysis failed.');
    if (run?.status === 'completed' && run.conclusion === 'success' && analysis && Number.isSafeInteger(analysis.rules_count) && analysis.rules_count > 0) {
      const alerts = await pages('code-scanning/alerts?state=open&ref=refs%2Fheads%2Fmain');
      if (alerts.length) throw new Error(`Publication blocked by ${alerts.length} open default-branch code-scanning alerts.`);
      return { sha, workflowRun: run.id, analysis: analysis.id, rules: analysis.rules_count };
    }
    if (now() >= deadline) throw new Error('No completed full security analysis exists for the exact release commit.');
    await pause(Math.min(5000, Math.max(0, deadline - now())));
  }
}

async function main() {
  const base = process.env.RELEASE_BASE_SHA || (process.env.GITHUB_EVENT_NAME === 'workflow_dispatch'
    ? execFileSync('git', ['rev-parse', 'HEAD^'], { encoding: 'utf8' }).trim() : '');
  if (!/^[a-f0-9]{40}$/.test(base || '') || /^0+$/.test(base)) throw new Error('An existing event base commit is required for the version gate.');
  const git = args => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
  const current = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const previous = JSON.parse(git(['show', `${base}:package.json`]));
  const changed = git(['diff', '--name-only', '-z', base, 'HEAD']).split('\0').filter(Boolean);
  const result = releasePolicy({ version: current.version, previousVersion: previous.version, changed });
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `version=${result.version}\npublish=${result.publish}\n`);
  console.log(JSON.stringify(result));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
