import { CareerError } from '../mcp/state.mjs';
import { openaiDecisionProvider } from './providers/openai.mjs';

// Providers are local implementations, never caller-supplied endpoints.
export const decisionProviders = Object.freeze({ openai: openaiDecisionProvider });
export function getDecisionProvider(id) {
  if (typeof id !== 'string' || !Object.hasOwn(decisionProviders, id)) {
    throw new CareerError('PRESCAN_UNSUPPORTED_PROVIDER', 'Select a supported pre-scan provider.');
  }
  return decisionProviders[id];
}
