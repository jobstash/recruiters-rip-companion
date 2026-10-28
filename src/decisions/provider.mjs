import { CareerError } from '../mcp/state.mjs';

// The one Decisions provider the companion talks to, used only for browser-form known-value mapping.
// Providers are local descriptors, never caller-supplied endpoints.
export const openaiDecisions = Object.freeze({ id: 'openai', label: 'OpenAI Decisions', model: 'gpt-6-luna', inputUsdPerMillion: 0.10 });
export const decisionProviders = Object.freeze({ openai: openaiDecisions });
export function getDecisionProvider(id) {
  if (typeof id !== 'string' || !Object.hasOwn(decisionProviders, id)) {
    throw new CareerError('DECISIONS_UNSUPPORTED_PROVIDER', 'Select a supported Decisions provider.');
  }
  return decisionProviders[id];
}
