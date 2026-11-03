import { createCareerState, fail, readCareer } from './state.mjs';
import { assertJobNotBlocked } from './blocklist.mjs';
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const object = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const PLATFORM_JOB_ID = /^node:[1-9][0-9]{0,18}$/;
const introPathsSchema = object({ jobIds: { type: 'array', minItems: 1, maxItems: 10, uniqueItems: true, items: { type: 'string', pattern: PLATFORM_JOB_ID.source } } }, ['jobIds']);

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
      description: 'People the candidate knows at the employers of up to 10 platform jobs (recruiters.rip connections), from recruiters.rip’s GitHub collaboration graph: direct coworkers (hops 1) and people reachable through one shared contact (hops 2). Call it yourself whenever you work on platform jobs. Each path names real GitHub identities (login, name, avatar, profile URL) and up to three verified commit emails per person, with the shared organizations, repositories and overlap dates as evidence. Requires current paid membership and a linked GitHub account (github null → call account_github_connect). Relationships are inferred from overlapping contributions, not confirmed; local job IDs are not supported.',
      async invoke(args = {}) {
        if (!record(args) || !Array.isArray(args.jobIds) || !args.jobIds.length || args.jobIds.length > 10)
          fail('INVALID_INPUT', 'Provide 1–10 platform job IDs.');
        if (args.jobIds.some(id => typeof id !== 'string' || !PLATFORM_JOB_ID.test(id)))
          fail('INVALID_INPUT', 'Intro paths exist only for platform jobs (node:<id>).');
        const before = readCareer(store);
        for (const id of args.jobIds) assertJobNotBlocked(before, id);
        const result = await platform('intro_paths', { jobIds: args.jobIds });
        const current = readCareer(store);
        for (const id of args.jobIds) assertJobNotBlocked(current, id);
        // The scorer's source label is an internal detail; the candidate sees recruiters.rip connections.
        if (!record(result)) return result;
        const { source: _source, ...connections } = result;
        return connections;
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
