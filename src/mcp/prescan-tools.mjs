import { fail } from './state.mjs';
import { PUBLICATION_RANGES } from '../prescan/publication-range.mjs';

const object = properties => ({ type: 'object', properties, additionalProperties: false });
function exact(args, fields) {
  if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).some(key => !fields.includes(key)))
    fail('INVALID_INPUT', 'Provide only the documented pre-scan arguments. API keys can only be entered in companion settings.');
}

/** All sessions share the main-process controller; the caller supplies its socket identity guards. */
export function createPrescanTools({ controller }) {
  return [
    {
      name: 'career_prescan_range_set', readOnly: false,
      description: 'Save the Companion publication slider selection: today, yesterday, past 3 days, past week, past 2 weeks, past month or whole catalogue. Changes stop active pre-filtering without starting another scan or imposing a job-count cap.',
      inputSchema: { ...object({ publicationRange: { type: 'string', enum: PUBLICATION_RANGES } }), required: ['publicationRange'] },
      async invoke(args = {}) { exact(args, ['publicationRange']); return controller.setPublicationRange(args); },
    },
    {
      name: 'career_prescan_preview', readOnly: true,
      description: 'Read the middleware-backed publication scope count, jobs needing Decisions, reusable results and rough Cost ESTIMATE for the selected slider range. Fetches catalogue metadata only, with no provider calls or persistent career changes. No job-count cap. Use before starting a scan.',
      inputSchema: object({ publicationRange: { type: 'string', enum: PUBLICATION_RANGES }, refresh: { type: 'boolean', default: false } }),
      async invoke(args = {}) { exact(args, ['publicationRange', 'refresh']); return controller.preview(args); },
    },
    {
      name: 'career_prescan_start', readOnly: false,
      description: 'Pre-filter every eligible pending job in the selected publication range with OpenAI Decisions, without a job-count limit and without any approval dialog. Show career_prescan_preview totalCatalogue, jobCount and Cost ESTIMATE first; the scan starts on this call with the current scope snapshot. Reuse current successful results unless refresh is true. No automatic paid retries or bulk LLM-review fallback; keys stay in companion settings.',
      inputSchema: object({ publicationRange: { type: 'string', enum: PUBLICATION_RANGES }, refresh: { type: 'boolean', default: false } }),
      async invoke(args = {}) { exact(args, ['publicationRange', 'refresh']); return controller.start(args); },
    },
    {
      name: 'career_prescan_status', readOnly: true,
      description: 'First check for job discovery: read Decisions key availability, local pre-scan progress and usage cost estimate without fetching jobs or making provider calls. Recommend companion Settings → Optional Decisions API when setup is missing; use career_prescan_preview for the full pending job count and Cost ESTIMATE before new scan approval. Reuse current results; interrupted runs do not restart automatically.',
      inputSchema: object({}),
      async invoke(args = {}) { exact(args, []); return controller.status(); },
    },
    {
      name: 'career_prescan_cancel', readOnly: false,
      description: 'Stop the active pre-scan without removing completed results. Already dispatched provider requests may still be billed. Never changes final subscription assessments.',
      inputSchema: object({}),
      async invoke(args = {}) { exact(args, []); return controller.cancel(); },
    },
  ];
}
