'use strict';

(() => {
  const element = name => document.getElementById(`prescan-${name}`);
  const key = element('key');
  const provider = element('provider');
  const limit = element('limit');
  let current = null;
  let paired = false;
  let pending = false;
  let generation = 0;

  const count = value => Number.isSafeInteger(value) && value >= 0 ? value.toLocaleString() : '—';
  const recovery = code => {
    switch (code) {
      case 'CANCELLED': return 'Pre-scan was not started. No API requests were sent.';
      case 'LOCAL_LOCKED': return 'Unlock local storage before continuing.';
      case 'PROFILE_INCOMPLETE': return 'Save your CV and career profile before starting a pre-scan.';
      case 'PAIRING_REQUIRED':
      case 'DEVICE_UNAUTHORIZED': return 'Check the account connection and job-feed membership.';
      case 'PROFILE_CHANGED':
      case 'RANKINGS_CHANGED': return 'The career context or rankings changed. Start a new pre-scan with the current data.';
      case 'PRESCAN_KEY_REQUIRED': return 'Save an OpenAI API key before starting.';
      case 'PRESCAN_INVALID_KEY':
      case 'PRESCAN_AUTH': return 'Replace the API key and check its OpenAI API permissions, then start again.';
      case 'PRESCAN_RATE_LIMIT': return 'Check your OpenAI API quota and billing, then try again later.';
      case 'PRESCAN_TIMEOUT': return 'OpenAI did not respond in time. Try again later; requests already sent may still be billed.';
      case 'PRESCAN_NETWORK': return 'Check your connection before starting again.';
      case 'PRESCAN_INVALID_RESPONSE':
      case 'PRESCAN_PROVIDER_ERROR': return 'OpenAI could not return a usable result. Try again later.';
      case 'PRESCAN_CANCELLED': return 'The request was cancelled. Requests already sent may still be billed.';
      default: return 'Check your API key, OpenAI billing and connection before starting again.';
    }
  };

  function render() {
    const credentials = current?.credentials;
    const run = current?.run;
    const available = Boolean(credentials && run);
    const running = run?.status === 'running';
    provider.disabled = !available || pending || running;
    key.disabled = !available || pending;
    limit.disabled = !available || pending || running;
    element('save').disabled = !available || pending || !key.value;
    element('remove').disabled = !available || pending || !credentials.configured;
    element('start').disabled = !available || pending || running;
    element('start').textContent = available && !credentials.configured ? 'Set up pre-scan'
      : available && !paired ? 'Connect account' : 'Start pre-scan';
    element('cancel').disabled = !available || pending || !running;
    element('form').setAttribute('aria-busy', String(pending));
    element('controls').setAttribute('aria-busy', String(pending));
    element('key-status').textContent = !available ? 'Open local storage to manage your API key.'
      : credentials.configured ? 'API key saved on this computer.'
        : 'No API key saved on this computer.';

    if (!available) {
      element('progress').textContent = 'No pre-scan state available.';
      element('usage').textContent = '';
      element('recovery').textContent = '';
      return;
    }
    const labels = {
      idle: 'No scan yet.', running: 'Scanning…', completed: 'Pre-scan complete.',
      cancelled: 'Scan canceled.', failed: 'Scan stopped.',
      stale: 'Results need updating.', interrupted: 'Scan interrupted.',
    };
    const progress = run.status === 'idle' ? ''
      : ` ${count(run.processed)}/${count(run.selected)} jobs · ${count(run.unavailable)} unresolved.`;
    element('progress').textContent = `${labels[run.status] || 'Pre-scan status unavailable.'}${progress}`;
    const usage = [];
    if (Number.isSafeInteger(run.requests)) usage.push(`${count(run.requests)} requests`);
    if (Number.isSafeInteger(run.inputTokens)) usage.push(`${count(run.inputTokens)} input tokens`);
    if (Number.isFinite(run.estimatedCostUsd) && run.estimatedCostUsd >= 0) {
      usage.unshift(`Est. US$${run.estimatedCostUsd.toFixed(6).replace(/0+$/, '').replace(/\.$/, '')}`);
    }
    element('usage').textContent = run.status !== 'idle' && usage.length
      ? `${usage.join(' · ')}. Base-rate estimate; actual charges may differ.` : '';
    let advice = '';
    if (run.status === 'failed') advice = `Results kept. ${recovery(run.lastError?.code)}`;
    if (run.status === 'cancelled' || run.status === 'interrupted') advice = 'Results kept. Restart to continue. Sent requests may still be billed.';
    if (run.status === 'stale') advice = 'Run a new pre-scan with your current profile.';
    element('recovery').textContent = advice;
  }

  function clearInput() {
    key.value = '';
    render();
  }

  function clear() {
    generation += 1;
    current = null;
    key.value = '';
    element('message').textContent = '';
    element('key-message').textContent = '';
    render();
  }

  function refresh(publicState, accountPaired = paired) {
    if (!publicState?.credentials || !publicState?.run) { clear(); return; }
    current = publicState;
    paired = accountPaired;
    const descriptor = publicState.credentials.providers?.find(item => item.id === 'openai');
    provider.options[0].textContent = descriptor?.label || 'OpenAI Decisions';
    provider.value = 'openai';
    render();
  }

  async function invoke(op, input) {
    const response = await window.companion.invoke(op, input);
    if (!response.ok) {
      const error = new Error(response.error?.message || 'Pre-scan action failed.');
      error.code = response.error?.code;
      throw error;
    }
    return response.result;
  }

  async function readState(token) {
    if (token !== generation) return;
    if (typeof window.refresh === 'function') {
      await window.refresh();
    } else {
      const state = await invoke('state', {});
      if (token !== generation) return;
      if (state.execution?.state === 'locked') clear();
      else refresh(state.prescan, state.paired);
    }
  }

  async function perform(op, input, success) {
    if (pending || !current) return;
    const token = generation;
    const message = element(op.startsWith('prescan-key-') ? 'key-message' : 'message');
    pending = true;
    message.textContent = op === 'prescan-start' ? 'Confirm sharing and API billing in the native dialog.' : 'Saving your request…';
    render();
    try {
      await invoke(op, input);
      if (token !== generation) return;
      message.textContent = success;
    } catch (error) {
      if (token !== generation) return;
      message.textContent = error.message === 'Pre-scan action failed.' ? recovery(error.code) : error.message;
    } finally {
      if (token === generation) {
        try { await readState(token); }
        catch {
          if (token === generation) {
            clear();
            element('message').textContent = 'Pre-scan state could not be read. Close and reopen the companion before trying again. Saved results have not been replaced.';
          }
        }
      }
      pending = false;
      render();
    }
  }

  element('form').addEventListener('submit', event => event.preventDefault());
  key.addEventListener('input', render);
  element('save').addEventListener('click', () => {
    if (pending || !current || !key.value) return;
    const input = { provider: provider.value, apiKey: key.value };
    key.value = '';
    void perform('prescan-key-save', input, 'API key saved.');
  });
  element('remove').addEventListener('click', () => {
    key.value = '';
    void perform('prescan-key-remove', { provider: provider.value }, 'API key removed. Requests already sent may still be billed.');
  });
  element('start').addEventListener('click', () => {
    if (pending || !current) return;
    if (!current.credentials.configured) {
      window.openCompanionSettings?.('prescan');
      return;
    }
    if (!paired) {
      window.openCompanionSettings?.('account-settings');
      return;
    }
    if (!limit.reportValidity()) return;
    const value = Number(limit.value);
    if (!Number.isInteger(value) || value < 1 || value > 2000) return;
    key.value = '';
    document.querySelector('[data-career-kind="jobs"]')?.click();
    void perform('prescan-start', { limit: value }, '');
  });
  element('cancel').addEventListener('click', () => {
    void perform('prescan-cancel', {}, 'Cancellation requested. Requests already sent may still be billed.');
  });

  // Navigation clears only unsaved input; parent state updates continue to own run status.
  const navigation = new MutationObserver(() => {
    if (document.getElementById('view-setup').hidden || document.getElementById('settings').hidden) {
      key.value = '';
      render();
    }
  });
  for (const id of ['view-setup', 'settings']) {
    navigation.observe(document.getElementById(id), { attributes: true, attributeFilter: ['hidden'] });
  }
  window.addEventListener('pagehide', clear);
  window.prescanUI = { refresh, clear, clearInput };
  clear();
})();
