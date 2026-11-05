import { createCareerState, fail } from './state.mjs';
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const object = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const GITHUB_LOGIN = /^(?!.*--)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,37}[a-zA-Z0-9])?(?![\s\S])/;
const endpointSchema = object({
  login: { type: 'string', minLength: 1, maxLength: 39, pattern: GITHUB_LOGIN.source },
  kind: { type: 'string', enum: ['user', 'organization'] },
}, ['login', 'kind']);
const introPathsSchema = object({
  source: endpointSchema,
  targets: { type: 'array', minItems: 1, maxItems: 20, items: endpointSchema },
}, ['targets']);

function endpoint(value) {
  if (!record(value) || Object.keys(value).some(key => !['login', 'kind'].includes(key)) ||
      typeof value.login !== 'string' || !GITHUB_LOGIN.test(value.login) ||
      !['user', 'organization'].includes(value.kind))
    fail('INVALID_INPUT', 'Provide a GitHub login and kind (user or organization), not a URL or company name.');
  return { login: value.login.toLowerCase(), kind: value.kind };
}

const state = career => record(career.introductions) ? career.introductions : {};
export function introductionsStatus(career) {
  const intro = state(career);
  return { github: intro.githubSkipped ? 'skipped' : intro.githubRequestedAt ? 'requested' : null };
}

export function createIntroductionTools({ store, platform, openGithub }) {
  const update = change => { let result; return store.update(next => { result = change(next.career ??= createCareerState()); }).then(() => result); };
  return [
    {
      name: 'career_intro_paths', readOnly: true, inputSchema: introPathsSchema,
      description: 'Inferred GitHub collaboration paths from a user or organization to 1–20 target users or organizations. Omit source to use the linked GitHub user, or provide an explicit source. Resolve actual target accounts from saved GitHub URLs or verified official public metadata, never guessed company-name slugs. Look up targets automatically for recommended, preparing and applying jobs, including local captures; direct requests need no job. Job IDs, publication dates, catalogue availability and job blocks do not scope this lookup. Results are grouped by target and retain source contributor identities and evidence for organization-origin paths. Contributions do not prove employment, acquaintance or willingness to introduce. Requires current membership; a missing default source is distinct from an unindexed account, no indexed paths, or graph unavailability.',
      async invoke(args = {}) {
        if (!record(args) || Object.keys(args).some(key => !['source', 'targets'].includes(key)) ||
            !Array.isArray(args.targets) || !args.targets.length || args.targets.length > 20)
          fail('INVALID_INPUT', 'Provide 1–20 GitHub targets and an optional GitHub source.');
        const source = Object.hasOwn(args, 'source') ? endpoint(args.source) : undefined;
        const targets = [], seen = new Set();
        for (const value of args.targets) {
          const target = endpoint(value), key = `${target.kind}:${target.login}`;
          if (!seen.has(key)) { seen.add(key); targets.push(target); }
        }
        return platform('intro_paths', { ...(source ? { source } : {}), targets });
      },
    },
    {
      name: 'career_introductions_update', readOnly: false,
      inputSchema: object({ githubSkipped: { type: 'boolean' } }, ['githubSkipped']),
      description: 'Record whether the candidate declined optional GitHub linking. Set githubSkipped only from their own answer.',
      async invoke(args = {}) {
        if (!record(args) || Object.keys(args).some(key => key !== 'githubSkipped') || typeof args.githubSkipped !== 'boolean')
          fail('INVALID_INPUT', 'Provide githubSkipped as true or false.');
        return update(career => {
          const intro = career.introductions = record(career.introductions) ? career.introductions : {};
          intro.githubSkipped = args.githubSkipped;
          return introductionsStatus(career);
        });
      },
    },
    {
      name: 'account_github_connect', readOnly: false, inputSchema: object({}),
      description: 'Open the recruiters.rip account page where the candidate links GitHub through their sign-in (optional; for developers with open-source work, so JobStash can confirm those contributions are theirs). Afterwards call account_status and check platform.github.login before telling them it is linked.',
      async invoke() {
        await openGithub();
        await update(career => {
          const intro = career.introductions = record(career.introductions) ? career.introductions : {};
          intro.githubRequestedAt = new Date().toISOString();
          intro.githubSkipped = false;
        });
        return { opened: true, next: 'Ask the candidate to choose Link GitHub on the opened page, then call account_status to confirm platform.github.login.' };
      },
    },
  ];
}
