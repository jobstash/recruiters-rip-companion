import { fail } from './state.mjs';

const object = properties => ({ type: 'object', properties, additionalProperties: false });
function exact(args, fields) {
  if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).some(key => !fields.includes(key)))
    fail('INVALID_INPUT', 'Provide only the documented pre-scan arguments. API keys can only be entered in companion settings.');
}

/** All sessions share the main-process controller; the caller supplies its socket identity guards. */
export function createPrescanTools({ controller }) {
  return [
    {
      name: 'career_prescan_start', readOnly: false,
      description: 'Request a finite, separately API-billed OpenAI job pre-scan. A native companion confirmation is required before career context and original advertisements are sent. This produces pre-scan priority only, never final subscription assessments. Enter API keys only in companion settings. Existing current scored pre-scan results are reused unless refresh is true; no automatic retries.',
      inputSchema: object({ limit: { type: 'integer', minimum: 1, maximum: 2000, default: 100 }, refresh: { type: 'boolean', default: false } }),
      async invoke(args = {}) { exact(args, ['limit', 'refresh']); return controller.start(args); },
    },
    {
      name: 'career_prescan_status', readOnly: true,
      description: 'Read local pre-scan progress and base-rate usage estimate without fetching jobs or making provider calls. Interrupted runs do not restart automatically.',
      inputSchema: object({}),
      async invoke(args = {}) { exact(args, []); return controller.status(); },
    },
    {
      name: 'career_prescan_results', readOnly: true,
      description: 'Read every saved pre-scan result, globally ordered before pagination. Priority is not a final fit score or hiring probability. Stale, unavailable, refused and conflict rows remain visible and still need subscription review. Does not require a provider key or network access.',
      inputSchema: object({ offset: { type: 'integer', minimum: 0, default: 0 }, limit: { type: 'integer', minimum: 1, maximum: 100, default: 25 } }),
      async invoke(args = {}) { exact(args, ['offset', 'limit']); return controller.results(args); },
    },
    {
      name: 'career_prescan_cancel', readOnly: false,
      description: 'Stop the active pre-scan without removing completed results. Already dispatched provider requests may still be billed. Never changes final subscription assessments.',
      inputSchema: object({}),
      async invoke(args = {}) { exact(args, []); return controller.cancel(); },
    },
  ];
}
