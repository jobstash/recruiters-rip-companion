'use strict';

(() => {
  const element = name => document.getElementById(`prescan-${name}`);
  const key = element('key');
  const jobsView = document.getElementById('view-jobs');
  const steps = { key: document.getElementById('run-step-key'), prefilter: document.getElementById('run-step-prefilter'), handover: document.getElementById('run-step-handover') };
  const keyAction = document.getElementById('jobs-prescan-settings');
  const handover = document.getElementById('copy-review-prompt');
  const range = element('range');
  const publicationRanges = [
    ['today', 'Today', 'today'], ['yesterday', 'Yesterday', 'since yesterday'], ['past_3_days', 'Past 3 days', 'in the past 3 days'],
    ['past_week', 'Past week', 'in the past week'], ['past_2_weeks', 'Past 2 weeks', 'in the past 2 weeks'],
    ['past_month', 'Past month', 'in the past month'], ['all', 'Whole catalogue', 'any time'],
  ];
  let current = null;
  let paired = false;
  let pending = false;
  let generation = 0;
  let starting = false;
  let cancelling = false;
  let context = '';
  let preview = null;
  let previewState = 'idle';
  let previewFailure = null;
  let previewRequest = 0;
  let rangeDraft = null;
  // The saved key stays active until a replacement is saved; Replace only reveals the entry field.
  let replacing = false;
  const savedDate = value => typeof value === 'string' && Number.isFinite(Date.parse(value))
    ? new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium' }).format(new Date(value)) : null;

  const count = value => Number.isSafeInteger(value) && value >= 0 ? value.toLocaleString() : '—';
  const cost = value => `US$${value.toFixed(2)}`;
  const recovery = code => {
    switch (code) {
      case 'CANCELLED': return 'Pre-filtering canceled.';
      case 'LOCAL_LOCKED': return 'Unlock local storage before continuing.';
      case 'PROFILE_INCOMPLETE': return 'Add your CV and career profile to start pre-filtering.';
      case 'PAIRING_REQUIRED':
      case 'DEVICE_UNAUTHORIZED': return 'Check the account connection and job-feed membership.';
      case 'PRESCAN_CONTEXT_CHANGED':
      case 'IDENTITY_CHANGED':
      case 'PROFILE_CHANGED':
      case 'RANKINGS_CHANGED': return 'Your profile or account changed. Start pre-filtering again.';
      case 'PRESCAN_KEY_REQUIRED': return 'Save an OpenAI API key before starting.';
      case 'PRESCAN_INVALID_KEY':
      case 'PRESCAN_AUTH': return 'Replace the API key and check its OpenAI API permissions, then start again.';
      case 'PRESCAN_RATE_LIMIT': return 'Check your OpenAI API quota and billing, then try again later.';
      case 'PRESCAN_TIMEOUT': return 'OpenAI timed out. Try again.';
      case 'PRESCAN_NETWORK': return 'Check your connection before starting again.';
      case 'PRESCAN_INVALID_RESPONSE':
      case 'PRESCAN_PROVIDER_ERROR': return 'OpenAI could not return a usable result. Try again later.';
      case 'PRESCAN_CANCELLED': return 'Request canceled.';
      default: return 'Check your API key, OpenAI billing and connection before starting again.';
    }
  };

  function render() {
    const credentials = current?.credentials;
    const run = current?.run;
    const available = Boolean(credentials && run);
    const running = run?.status === 'running';
    const configured = Boolean(available && credentials.configured);
    const entering = available && (!configured || replacing);
    key.disabled = !entering || pending;
    const needsSetup = available && (!credentials.configured || !paired);
    const selectedRange = rangeDraft ?? run?.publicationRange ?? 'past_3_days';
    const rangeIndex = publicationRanges.findIndex(([value]) => value === selectedRange);
    const rangeLabel = publicationRanges[rangeIndex < 0 ? 2 : rangeIndex][1];
    range.value = String(rangeIndex < 0 ? 2 : rangeIndex);
    range.disabled = !available || pending;
    range.setAttribute('aria-valuetext', rangeLabel);
    element('range-label').textContent = publicationRanges[rangeIndex < 0 ? 2 : rangeIndex][2];
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
    }
    element('replace').disabled = !configured || pending;
    element('remove').disabled = !configured || pending;
    element('start').disabled = !available || pending || running || (!needsSetup && previewState !== 'ready');
    element('start').textContent = available && !paired ? 'Connect account' : 'Start pre-filtering';
    element('cancel').hidden = !available || (!starting && !running);
    element('cancel').disabled = cancelling;
    element('form').setAttribute('aria-busy', String(pending));
    // The rail: one step is current and carries the primary action. Pre-filtering itself is either running or it is not.
    const currentStep = !available || !configured ? 'key' : run.status === 'completed' ? 'handover' : 'prefilter';
    for (const [name, step] of Object.entries(steps)) {
      if (name === currentStep) step.setAttribute('aria-current', 'step'); else step.removeAttribute('aria-current');
    }
    element('key-state').textContent = !available ? 'Open local storage.' : configured ? `Key …${credentials.keyHint} saved.` : 'No OpenAI key saved.';
    keyAction.textContent = configured ? 'Change key' : 'Add key';
    keyAction.classList.toggle('primary', currentStep === 'key'); keyAction.classList.toggle('ghost', currentStep !== 'key');
    keyAction.disabled = !available;
    element('start').classList.toggle('primary', currentStep === 'prefilter' && !running); element('start').classList.toggle('ghost', currentStep !== 'prefilter' || running);
    handover.classList.toggle('primary', currentStep === 'handover'); handover.classList.toggle('ghost', currentStep !== 'handover');
    // Blocked jobs stay in the scope total but are never pre-filtered.
    const blockedPart = () => Number.isSafeInteger(preview.blocked) && preview.blocked > 0 ? ` · ${count(preview.blocked)} blocked` : '';
    const scopeLine = () => preview.jobCount === 0 ? `${count(preview.totalCatalogue)} jobs in scope${blockedPart()} · all pre-filtered`
      : `${count(preview.totalCatalogue)} jobs in scope${blockedPart()} · ${count(preview.jobCount)} to pre-filter · ~${cost(preview.estimatedCostUsd)}`;
    element('preview').textContent = !available ? 'Open local storage to load the job count.'
      : running || starting ? ''
        : rangeDraft !== null ? pending ? 'Saving publication time…' : 'Job count needs updating.'
        : previewState === 'ready' ? scopeLine()
          : previewState === 'failed' ? previewFailure ?? 'Job count unavailable. Reopen Jobs to try again.'
            : 'Loading job count…';
    element('preview').setAttribute('aria-busy', String(previewState === 'loading'));
    // The state line is the first thing in the section: it says whether pre-filtering can run and which key does it.
    const since = savedDate(credentials?.savedAt);
    element('key-status').textContent = !available ? 'Open local storage to configure the optional Decisions API.'
      : !configured ? 'No API key saved. Job pre-filtering is off until you add an OpenAI API key.'
        : replacing ? `The key …${credentials.keyHint} stays active until you save a new one.`
          : `API key saved${since ? ` on ${since}` : ''}. Job pre-filtering can run.`;

    if (!available) { element('progress').textContent = ''; element('recovery').textContent = ''; return; }
    const blocked = Number.isSafeInteger(run.blocked) && run.blocked >= 0 ? run.blocked : 0;
    const fullScope = Number.isSafeInteger(run.totalCatalogue) && Number.isSafeInteger(run.reused) &&
      run.reused >= 0 && run.totalCatalogue === run.selected + run.reused + blocked;
    const checked = run.processed + (fullScope ? run.reused : 0);
    const scope = count(fullScope ? run.totalCatalogue - blocked : run.selected);
    const spent = Number.isFinite(run.estimatedCostUsd) && run.estimatedCostUsd > 0 ? ` · ${cost(run.estimatedCostUsd)}` : '';
    // Live progress only; a finished run is summarized by the scope line above.
    element('progress').textContent = running || starting
      ? `Pre-filtering ${count(checked)}/${scope}${spent}` : '';
    let advice = '';
    if (run.status === 'failed') advice = recovery(run.lastError?.code);
    if (run.status === 'cancelled' || run.status === 'interrupted') advice = `Scan stopped at ${count(checked)}/${scope}${spent}. Start again to continue.`;
    if (run.status === 'stale') advice = 'Profile changed. Start pre-filtering again.';
    if (run.status === 'completed' && run.unavailable) advice = `${count(run.unavailable)} jobs could not be pre-filtered.`;
    element('recovery').textContent = advice;
  }

  function clearInput() {
    key.value = '';
    replacing = false;
    render();
  }
  function invalidatePreview() {
    previewRequest += 1;
    preview = null;
    previewState = 'idle';
  }

  async function loadPreview() {
    if (!current || pending || rangeDraft !== null || current.run.status === 'running' || jobsView.hidden) return;
    const request = ++previewRequest;
    const token = generation;
    const expectedContext = context;
    preview = null;
    previewState = 'loading';
    render();
    try {
      const result = await invoke('prescan-preview', {});
      if (request !== previewRequest || token !== generation || expectedContext !== context) return;
      if (!Number.isSafeInteger(result?.jobCount) || result.jobCount < 0 ||
          !Number.isSafeInteger(result.totalCatalogue) || result.totalCatalogue < result.jobCount ||
          !Number.isFinite(result.estimatedCostUsd) || result.estimatedCostUsd < 0) throw new Error('Preview unavailable.');
      preview = result;
      previewState = 'ready';
    } catch (error) {
      if (request !== previewRequest || token !== generation || expectedContext !== context) return;
      previewState = 'failed';
      // Setup gaps are actionable; anything else keeps the generic retry line.
      previewFailure = ['PREFERENCES_REQUIRED', 'PROFILE_INCOMPLETE'].includes(error?.code) ? error.message : null;
    }
    render();
  }

  function clear() {
    generation += 1;
    current = null;
    context = '';
    rangeDraft = null;
    invalidatePreview();
    key.value = '';
    element('message').textContent = '';
    element('key-message').textContent = '';
    render();
  }

  function refresh(publicState, accountPaired = paired) {
    if (!publicState?.credentials || !publicState?.run) { clear(); return; }
    const nextContext = JSON.stringify([publicState.contextVersion, publicState.credentials.credentialVersion,
      publicState.run.runId, publicState.run.status, publicState.run.publicationRange, accountPaired]);
    const changed = nextContext !== context;
    if (changed) invalidatePreview();
    context = nextContext;
    current = publicState;
    paired = accountPaired;
    render();
    if (changed) void loadPreview();
  }

  async function invoke(op, input) {
    const response = await window.companion.invoke(op, input);
    if (!response.ok) {
      const error = new Error(response.error?.message || 'Pre-filtering failed.');
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
    starting = op === 'prescan-start';
    if (starting || op === 'prescan-range-set') invalidatePreview();
    message.textContent = starting ? 'Loading pre-filtering for approval…' : 'Saving…';
    render();
    try {
      await invoke(op, input);
      if (token !== generation) return;
      message.textContent = success;
    } catch (error) {
      if (token !== generation) return;
      message.textContent = error.message === 'Pre-filtering failed.' ? recovery(error.code) : error.message;
    } finally {
      if (token === generation) {
        try { await readState(token); }
        catch {
          if (token === generation) {
            clear();
            element('message').textContent = 'Could not load pre-filtering. Reopen the companion.';
          }
        }
      }
      pending = false;
      starting = false;
      if (op === 'prescan-range-set') rangeDraft = null;
      render();
      if (previewState === 'idle') void loadPreview();
    }
  }

  element('form').addEventListener('submit', event => event.preventDefault());
  range.addEventListener('input', () => {
    rangeDraft = publicationRanges[Number(range.value)][0];
    invalidatePreview();
    render();
  });
  range.addEventListener('change', () => {
    if (pending || !current) return;
    const publicationRange = publicationRanges[Number(range.value)][0];
    rangeDraft = publicationRange;
    void perform('prescan-range-set', { publicationRange }, '');
  });
  key.addEventListener('input', render);
  element('save').addEventListener('click', () => {
    if (pending || !current || !key.value) return;
    const input = { provider: 'openai', apiKey: key.value };
    key.value = '';
    replacing = false;
    void perform('prescan-key-save', input, 'Decisions API key saved. Job pre-filtering can run.');
  });
  element('replace').addEventListener('click', () => {
    if (pending || !current?.credentials.configured) return;
    replacing = true;
    element('key-message').textContent = '';
    render();
    key.focus();
  });
  element('cancel-entry').addEventListener('click', () => {
    clearInput();
    element('replace').focus();
  });
  element('remove').addEventListener('click', () => {
    key.value = '';
    replacing = false;
    void perform('prescan-key-remove', { provider: 'openai' }, 'API key removed. Job pre-filtering is off.');
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
    if (previewState !== 'ready') return;
    key.value = '';
    void perform('prescan-start', {}, '');
  });
  element('cancel').addEventListener('click', async () => {
    if (cancelling || !current || (!starting && current.run.status !== 'running')) return;
    const token = generation;
    cancelling = true;
    render();
    try {
      await invoke('prescan-cancel', {});
      if (token === generation) element('message').textContent = 'Cancellation requested.';
    } catch (error) {
      if (token === generation) element('message').textContent = error.message;
    } finally {
      cancelling = false;
      if (token === generation) {
        try { await readState(token); } catch { clear(); }
      }
      render();
    }
  });

  // The scope count is a middleware call, so it loads only while Jobs is on screen.
  new MutationObserver(() => {
    invalidatePreview();
    render();
    if (!jobsView.hidden) void loadPreview();
  }).observe(jobsView, { attributes: true, attributeFilter: ['hidden'] });

  // Leaving Settings drops any unsaved key text and a pending replacement; the saved key is unaffected.
  const navigation = new MutationObserver(() => {
    if (document.getElementById('view-setup').hidden || document.getElementById('settings').hidden) {
      key.value = '';
      replacing = false;
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
