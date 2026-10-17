import { CareerError } from '../mcp/state.mjs';
import { decisionProviders, getDecisionProvider } from './providers.mjs';

const version = state => Number.isSafeInteger(state.prescanCredentialVersion) && state.prescanCredentialVersion >= 0 ? state.prescanCredentialVersion : 0;
const validKey = key => typeof key === 'string' && /^sk-[A-Za-z0-9_-]{16,500}$/.test(key) && !/\s/.test(key);
function validate(args, saving) {
  const keys = saving ? ['provider', 'apiKey'] : ['provider'];
  if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).some(key => !keys.includes(key))) {
    throw new CareerError('PRESCAN_INVALID_INPUT', 'Use the local pre-scan settings to manage provider credentials.');
  }
  getDecisionProvider(args.provider);
  if (saving && !validKey(args.apiKey)) throw new CareerError('PRESCAN_INVALID_KEY', 'Enter an OpenAI API key without spaces, not a ChatGPT login token.');
}
function increment(state) {
  const current = version(state);
  if (current === Number.MAX_SAFE_INTEGER) throw new CareerError('PRESCAN_INVALID_INPUT', 'The credential version cannot be updated.');
  state.prescanCredentialVersion = current + 1;
}

// Main-process only. Expose publicState to UI; never expose read via IPC/MCP.
export function createPrescanCredentials({ store, onChange = () => {} }) {
  function publicState() {
    const state = store.get();
    const { id: provider, model, inputUsdPerMillion } = decisionProviders.openai;
    return { provider, model, configured: validKey(state.prescanCredentials?.openai?.apiKey), credentialVersion: version(state), inputUsdPerMillion,
      providers: Object.values(decisionProviders).map(({ id, label, model, inputUsdPerMillion }) => ({ id, label, model, inputUsdPerMillion })) };
  }
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
      if (!validKey(apiKey)) throw new CareerError('PRESCAN_KEY_REQUIRED', 'Save an OpenAI API key in the companion’s local pre-scan settings first.');
      return { apiKey, credentialVersion: version(state) };
    },
  };
}
