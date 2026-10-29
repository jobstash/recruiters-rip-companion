import { CareerError } from '../mcp/state.mjs';
import { decisionProviders, getDecisionProvider } from './provider.mjs';

const version = state => Number.isSafeInteger(state.prescanCredentialVersion) && state.prescanCredentialVersion >= 0 ? state.prescanCredentialVersion : 0;
const validKey = key => typeof key === 'string' && /^sk-[A-Za-z0-9_-]{16,500}$/.test(key) && !/\s/.test(key);
function validate(args, saving) {
  const keys = saving ? ['provider', 'apiKey'] : ['provider'];
  if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).some(key => !keys.includes(key))) {
    throw new CareerError('DECISIONS_INVALID_INPUT', 'Use the local Decisions API settings to manage the optional key.');
  }
  getDecisionProvider(args.provider);
  if (saving && !validKey(args.apiKey)) throw new CareerError('DECISIONS_INVALID_KEY', 'Enter an OpenAI API key without spaces, not a ChatGPT login token.');
}
function increment(state) {
  const current = version(state);
  if (current === Number.MAX_SAFE_INTEGER) throw new CareerError('DECISIONS_INVALID_INPUT', 'The credential version cannot be updated.');
  state.prescanCredentialVersion = current + 1;
}

/** Public credential metadata from an already-authorized local snapshot; no key material is returned. */
export function decisionCredentialStatus(state) {
  const { id: provider, model, inputUsdPerMillion } = decisionProviders.openai;
  const saved = state.prescanCredentials?.openai;
  const configured = validKey(saved?.apiKey);
  return { provider, model, configured, credentialVersion: version(state), inputUsdPerMillion,
    savedAt: configured && typeof saved.updatedAt === 'string' ? saved.updatedAt : null,
    keyHint: configured ? saved.apiKey.slice(-4) : null,
    providers: Object.values(decisionProviders).map(({ id, label, model, inputUsdPerMillion }) => ({ id, label, model, inputUsdPerMillion })) };
}

// Main-process only. Expose publicState to UI; never expose read via IPC/MCP. The vault fields keep their historical
// `prescan*` names so saved keys survive the removal of job pre-scanning.
export function createDecisionCredentials({ store, onChange = () => {} }) {
  const publicState = () => decisionCredentialStatus(store.get());
  return {
    publicState,
    async save(args) {
      validate(args, true);
      const { provider, apiKey } = args;
      await store.update(state => {
        increment(state);
        state.prescanCredentials ??= {};
        state.prescanCredentials[provider] = { apiKey, updatedAt: new Date().toISOString() };
      });
      await onChange();
      return publicState();
    },
    async remove(args) {
      validate(args, false);
      const { provider } = args;
      await store.update(state => { increment(state); if (state.prescanCredentials) delete state.prescanCredentials[provider]; });
      await onChange();
      return publicState();
    },
    read(provider) {
      getDecisionProvider(provider);
      const state = store.get(), apiKey = state.prescanCredentials?.[provider]?.apiKey;
      if (!validKey(apiKey)) throw new CareerError('DECISIONS_KEY_REQUIRED', 'Save an OpenAI API key in the companion’s local Decisions API settings first.');
      return { apiKey, credentialVersion: version(state) };
    },
  };
}
