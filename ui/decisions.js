// Settings → Form filling: one optional OpenAI key selects known browser form answers.
// The secret lives in the main process; this UI sees a four-character hint and a save date.
(() => {
  const element = name => document.getElementById(`decisions-${name}`);
  const key = element('key');
  let credentials = null;
  let available = false;
  let replacing = false;
  let pending = false;

  const savedDate = value => typeof value === 'string' && Number.isFinite(Date.parse(value))
    ? new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium' }).format(new Date(value)) : null;

  function render() {
    const configured = Boolean(available && credentials?.configured);
    const entering = available && (!configured || replacing);
    key.disabled = !entering || pending;
    element('save').disabled = !entering || pending || !key.value;
    element('save').textContent = configured ? 'Save new key' : 'Save key';
    element('key-label').textContent = configured ? 'New OpenAI API key' : 'OpenAI API key';
    element('key-saved').hidden = !configured || replacing;
    element('key-entry').hidden = !entering;
    element('cancel-entry').hidden = !(configured && replacing);
    // The buttons name the key they act on; the hint keeps its real case so it can be matched against the OpenAI dashboard.
    for (const name of ['replace', 'remove']) {
      const button = element(name);
      button.replaceChildren(`${name === 'replace' ? 'Replace' : 'Remove'} key`);
      if (configured) { const span = document.createElement('span'); span.className = 'key-hint'; span.textContent = ` …${credentials.keyHint}`; button.append(span); }
      button.disabled = !configured || pending;
    }
    element('form').setAttribute('aria-busy', String(pending));
    const since = savedDate(credentials?.savedAt);
    element('key-status').textContent = !available ? 'Unlock your saved work to use help with forms.'
      : !configured ? 'No key saved. Read page can still use your saved details in Chrome and Firefox.'
        : replacing ? `The key …${credentials.keyHint} stays active until you save a new one.`
          : `Key saved${since ? ` on ${since}` : ''}. OpenAI can help choose answers from your saved details.`;
  }

  async function invoke(op, input) {
    const response = await window.companion.invoke(op, input);
    if (!response.ok) throw Object.assign(new Error(response.error?.message || 'The key could not be saved.'), { code: response.error?.code });
    return response.result;
  }
  async function perform(op, input, success) {
    if (pending) return;
    pending = true;
    const message = element('key-message');
    message.textContent = 'Saving…';
    render();
    try {
      await invoke(op, input);
      message.textContent = success;
      if (typeof window.refresh === 'function') await window.refresh();
    } catch (error) {
      message.textContent = error.message;
    } finally {
      pending = false;
      render();
    }
  }

  function refresh(state) {
    available = Boolean(state?.credentials);
    credentials = state?.credentials ?? null;
    // A draft that the saved state already matches is no longer a draft.
    if (!available) { key.value = ''; replacing = false; }
    render();
  }
  function clear() { available = false; credentials = null; key.value = ''; replacing = false; render(); }
  function clearInput() { key.value = ''; replacing = false; element('key-message').textContent = ''; render(); }

  element('form').addEventListener('submit', event => event.preventDefault());
  key.addEventListener('input', render);
  element('save').addEventListener('click', () => {
    if (pending || !available || !key.value) return;
    const input = { provider: 'openai', apiKey: key.value };
    key.value = '';
    replacing = false;
    void perform('decisions-key-save', input, 'Key saved. OpenAI can help choose answers from your saved details.');
  });
  element('replace').addEventListener('click', () => {
    if (pending || !credentials?.configured) return;
    replacing = true;
    element('key-message').textContent = '';
    render();
    key.focus();
  });
  element('cancel-entry').addEventListener('click', () => {
    key.value = '';
    replacing = false;
    render();
    element('replace').focus();
  });
  element('remove').addEventListener('click', () => {
    key.value = '';
    replacing = false;
    void perform('decisions-key-remove', { provider: 'openai' }, 'Key removed. Read page can still use your saved details.');
  });
  window.decisionsUI = { refresh, clear, clearInput };
})();
