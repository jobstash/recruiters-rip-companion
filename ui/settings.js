'use strict';
const $ = id => document.getElementById(id);
let state, busy = false, noticeKind = '', noticeTimer, careerViewVersion, stateRequest = 0, view = null;
let requestedSection = null, stateNoticeKey = '';
const notice = (text, kind = '') => {
  clearTimeout(noticeTimer);
  $('notice-text').textContent = text || '';
  $('notice').hidden = !text;
  noticeKind = text ? kind : '';
  if (text) noticeTimer = setTimeout(() => notice(''), 10000);
};
const stateNotice = (text, kind = '') => {
  const key = text ? `${kind}:${text}` : '';
  if (stateNoticeKey === key) return;
  stateNoticeKey = key;
  if (text) notice(text, kind);
};
$('notice-close').addEventListener('click', () => notice(''));
window.showCompanionNotice = notice;
// The topbar wraps at narrow widths, so the toast anchors to its measured height rather than a constant.
new ResizeObserver(([entry]) => document.documentElement.style.setProperty('--topbar-height', `${entry.borderBoxSize[0].blockSize}px`)).observe(document.querySelector('.topbar'));
async function invoke(op, input = {}) { const response = await window.companion.invoke(op, input); if (!response.ok) throw new Error(response.error.message); return response.result; }
const views = ['me', 'jobs', 'pipeline', 'setup', 'help'];
function showView(next) {
  view = next;
  for (const button of document.querySelectorAll('[data-view]')) {
    if (button.dataset.view === next) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current');
  }
  for (const name of views) $(`view-${name}`).hidden = name !== next;
  if (next !== 'setup') window.decisionsUI?.clearInput();
}
for (const button of document.querySelectorAll('[data-view]')) button.addEventListener('click', () => showView(button.dataset.view));
function selectSettingsTab(next, focus = false) {
  for (const tab of document.querySelectorAll('[data-settings-tab]')) {
    const selected = tab.dataset.settingsTab === next;
    tab.setAttribute('aria-selected', String(selected));
    tab.tabIndex = selected ? 0 : -1;
    $(tab.getAttribute('aria-controls')).hidden = !selected;
    if (selected && focus) tab.focus();
  }
  if (next !== 'general') window.decisionsUI?.clearInput();
}
const settingsTabs = [...document.querySelectorAll('[data-settings-tab]')];
for (const tab of settingsTabs) {
  tab.addEventListener('click', () => selectSettingsTab(tab.dataset.settingsTab));
  tab.addEventListener('keydown', event => {
    let index = settingsTabs.indexOf(tab);
    if (event.key === 'ArrowRight') index = (index + 1) % settingsTabs.length;
    else if (event.key === 'ArrowLeft') index = (index + settingsTabs.length - 1) % settingsTabs.length;
    else if (event.key === 'Home') index = 0;
    else if (event.key === 'End') index = settingsTabs.length - 1;
    else return;
    event.preventDefault();
    selectSettingsTab(settingsTabs[index].dataset.settingsTab, true);
  });
}
$('help-backups').addEventListener('click', () => {
  showView('setup');
  selectSettingsTab('backups', true);
});
function openSettings(target) {
  showView('setup');
  selectSettingsTab('general');
  const section = $(target);
  if (!section) return;
  section.scrollIntoView({ block: 'start' });
  [...section.querySelectorAll('input:not(:disabled), button:not(:disabled, .link), summary')].find(control => control.getClientRects().length)?.focus({ preventScroll: true });
}
window.openCompanionSettings = openSettings;
$('me-account').addEventListener('click', () => openSettings('account-settings'));
$('me-jobs').addEventListener('click', () => showView('jobs'));
$('setup-next').addEventListener('click', () => {
  const next = $('setup-next').dataset.action;
  if (next === 'account') $('connect-account').click();
  else if (next === 'cv') $('import-cv').click();
  else if (next === 'ai') openSettings('chat-app-settings');
  else if (next === 'search') $($('setup-next').dataset.target).click();
  else if (next === 'retry') void refresh();
});
// Help reads the running package version from the same state snapshot Settings → Updates renders.
window.helpUI = {
  refresh(current) { $('help-version').textContent = typeof current?.updates?.version === 'string' ? `Version ${current.updates.version}` : ''; },
  clear() { $('help-version').textContent = ''; },
};
// Setup and automatic skill refresh take effect in new sessions, not already loaded conversations.
const restartLine = (host, mode) => host === 'codex' ? 'Start a new Codex conversation. If recruiters.rip is not available, restart Codex.'
  : mode === 'cli' ? 'Start a new Claude Code session.' : 'Start a new Claude conversation. If recruiters.rip is not available, quit Claude completely and reopen it.';
// The first-run path, in order. Each step is done from authoritative state; the last ends in the AI app, whose reviews fill Jobs.
const setupSteps = [['paired', 'Connect account'], ['hasCv', 'Import CV'], ['ai', 'Add Codex or Claude'], ['hasReviews', 'Start a job search']];
let setupSignature = '';
function renderSetup(current) {
  const added = current?.review?.added ?? {};
  const ai = Boolean(added.codex || added.claude || added.other || current?.mcpClients?.some(Boolean));
  const hosts = current?.review?.hosts ?? {}, preferred = current?.review?.preferredHost;
  const searchHost = hosts[preferred] ? preferred : ['codex', 'claude'].find(host => hosts[host]) ?? null;
  const done = current ? { paired: current.paired, hasCv: current.hasCv, ai, hasReviews: current.hasReviews } : null;
  const signature = JSON.stringify(done ? [done, searchHost] : null);
  if (signature === setupSignature) return;
  setupSignature = signature;
  const next = !done ? 'retry' : !done.paired ? 'account' : !done.hasCv ? 'cv' : !ai ? 'ai' : !done.hasReviews ? 'search' : null;
  $('me-setup').hidden = !next;
  $('me-account').hidden = Boolean(current?.paired) || next === 'account';
  if (!next) return;
  const hostName = searchHost === 'codex' ? 'Codex' : 'Claude';
  const copy = {
    account: ['Connect your account', 'Connect recruiters.rip to see new jobs. You can import your CV now, even without an account.', 'Connect account'],
    cv: ['Import your CV', 'Add your CV so Codex or Claude can find jobs that fit your experience.', 'Import CV'],
    ai: ['Add your AI app', 'Add recruiters.rip to Codex or Claude in Settings → AI apps.', 'AI apps'],
    search: ['Start a job search', 'Your AI app reviews the new jobs. The ones that fit appear in Jobs → Reviewed.', searchHost ? `Continue in ${hostName}` : 'Copy prompt'],
    retry: ['Companion is unavailable', 'Your saved work is unchanged. Retry, or reopen Companion.', 'Retry'],
  }[next];
  $('setup-next-title').textContent = copy[0];
  $('setup-next-description').textContent = copy[1];
  $('setup-next-steps').hidden = !done;
  $('setup-next-status').textContent = done ? '' : 'Could not check your connection';
  if (done) $('setup-next-steps').replaceChildren(...setupSteps.map(([key, label]) => {
    const item = document.createElement('li');
    item.textContent = done[key] ? `${label} · Done` : label;
    if (key === { account: 'paired', cv: 'hasCv', ai: 'ai', search: 'hasReviews' }[next]) item.setAttribute('aria-current', 'step');
    return item;
  }));
  $('setup-next').textContent = copy[2];
  $('setup-next').dataset.action = next;
  $('setup-next').dataset.target = searchHost ? `review-${searchHost}` : 'copy-review-prompt';
}
// "Added" is the app's own config naming recruiters.rip; "In use now" is a live session that Continue in that app can use, from
// the clientInfo the session declared (Companion maps the names). Sessions come and go with conversations and Companion restarts,
// so their absence is never reported as a fault.
function renderIntegrations(current) {
  const hosts = current.review?.hostInfo ?? {}, added = current.review?.added ?? {}, live = current.review?.live ?? {};
  const restart = current.review?.restart ?? {}, other = current.review?.other ?? [];
  $('claude-host-label').textContent = hosts.claude?.mode === 'cli' ? 'Claude Code' : 'Claude';
  for (const host of ['codex', 'claude']) {
    const info = hosts[host];
    $(`${host}-status`).textContent = live[host] ? 'In use now' : added[host] ? 'Added' : '';
    $(`${host}-get-step`).hidden = info?.available !== false;
    $(`get-${host}`).disabled = busy;
    $(host === 'codex' ? 'install-chatgpt' : 'install-claude').disabled = busy || !info?.available;
    $(`setup-${host}`).disabled = busy || !info?.available;
    const error = current.review?.errors?.find(error => error.host === host);
    const message = $(`${host}-restart`);
    message.hidden = !error && !restart[host];
    message.setAttribute('role', error ? 'alert' : 'status');
    message.textContent = error?.message || (restart[host] ? restartLine(host, info?.mode) : '');
  }
  $('claude-extension').hidden = !(added.claude && added.claudeExtension && hosts.claude?.mode !== 'cli');
  // In a container the per-app rows are hidden, so every live session is named here.
  const container = Boolean(current.shell?.container);
  const inUse = container ? [live.codex && 'Codex', live.claude && 'Claude Code', ...other].filter(Boolean) : other;
  $('other-connections').hidden = !inUse.length;
  $('other-connections').textContent = inUse.length ? `${container ? 'In use now' : 'Also in use now'}: ${inUse.join(', ')}` : '';
  // Only a live extension connection or a failed browser registration earns a line; otherwise the steps say what to do.
  for (const browser of ['chrome', 'firefox']) {
    const integration = current.browserIntegration;
    $(`${browser}-native-status`).textContent = integration?.connected?.includes(browser) ? 'Connected'
      : ['installed', 'unavailable'].includes(current.browserConnection) && !integration?.registered?.[browser] ? 'Unavailable. Reopen Companion.' : '';
    // A container cannot open this computer's browsers or folders: the steps show the command and the address instead.
    if (container) {
      $(`${browser}-browser-setup`).textContent = current.shell.browserSetup?.[browser] ?? '';
      $(`${browser}-extensions-manual`).hidden = false;
    }
  }
}
async function refresh() {
  const request = ++stateRequest;
  try {
    const current = await invoke('state');
    if (request !== stateRequest) return;
    state = current;
    document.documentElement.toggleAttribute('data-container', Boolean(state.shell?.container));
    if (noticeKind === 'state-unavailable') notice('');
    const locked = state.execution.state === 'locked';
    window.backupsUI?.refresh(current);
    $('storage').hidden = !locked; $('settings').hidden = locked; $('views').hidden = locked;
    $('storage-message').textContent = state.failure || 'Choose Unlock to open your saved work.';
    if (state.approval && !locked) {
      $('approval-title').textContent = state.approval.title; $('approval-detail').textContent = state.approval.detail;
      $('approval-cancel').disabled = false; $('approval-allow').disabled = false;
      if (!$('approval-dialog').open) $('approval-dialog').showModal();
    } else if ($('approval-dialog').open) $('approval-dialog').close();
    if (locked) {
      $('agent-prompt').textContent = '';
      window.careerBrowser?.clear(); careerViewVersion = undefined;
      window.decisionsUI?.clear();
      window.updatesUI?.clear();
      window.careerGapUI?.clear();
      window.helpUI.clear();
      return;
    }
    $('connect-account').textContent = state.paired ? 'Open account' : 'Connect account';
    $('connect-account').classList.toggle('primary', !state.paired);
    $('connect-account').classList.toggle('ghost', state.paired);
    $('account-hint').textContent = state.paired ? 'Account connected. A paid membership is needed for new jobs. You can still use your saved work without a membership.'
      : state.reconnectAccount ? `This computer was disconnected from recruiters.rip. Connect ${state.reconnectAccount.label} again to see new jobs. Your saved work is still available.` : 'Not connected. Connect to see new jobs, or keep working with your CV and saved jobs.';
    renderSetup(state);
    syncGithub(state.paired);
    if (!view) showView('me');
    if (state.paired && noticeKind === 'connect-account') notice('');
    if (window.careerBrowser && careerViewVersion !== state.careerViewVersion) {
      careerViewVersion = state.careerViewVersion;
      void window.careerBrowser.refresh();
    }
    $('agent-prompt').textContent = state.setup.agentPrompt;
    renderIntegrations(state);
    window.decisionsUI?.refresh(state.decisions);
    window.careerBrowser?.setContext({ review: state.review, publicationRange: state.publicationRange, paired: state.paired, catalogue: state.catalogue });
    window.updatesUI?.refresh(state.updates);
    window.careerGapUI?.refresh(state.careerGap);
    window.helpUI.refresh(state);
    if (requestedSection) { const section = requestedSection; requestedSection = null; openSettings(section); }
    stateNotice(state.failure || state.review?.errors?.map(error => error.message).join(' ') || '', 'error');
  } catch {
    if (request !== stateRequest) return;
    if (!state) {
      $('settings').hidden = false; $('views').hidden = false;
      if (!view) showView('me');
    }
    renderSetup(null);
    window.backupsUI?.unavailable();
    $('codex-status').textContent = ''; $('claude-status').textContent = '';
    stateNotice('Could not reach Companion. Choose Retry in Me, or reopen Companion. Your saved work is unchanged.', 'state-unavailable');
  }
}
async function action(op, success) {
  if (busy || window.backupsUI?.isBusy()) return;
  busy = true;
  window.backupsUI?.setBusy(true);
  // Browser instances manage their own controls; the Jobs toolbar's Copy review prompt is an ordinary action.
  const controls = [...document.querySelectorAll('button')].filter(button => (!button.closest('#notice, #me-browser, #career-browser, #pipeline-browser, #views, #decisions, #update-settings, #settings-backups, .settings-tabs') || ['copy-review-prompt', 'review-codex', 'review-claude'].includes(button.id)) && !['approval-cancel', 'approval-allow'].includes(button.id));
  const disabled = controls.map(control => control.disabled); controls.forEach(control => { control.disabled = true; });
  try {
    const result = await invoke(op);
    if (op === 'import-cv' && !result.cancelled) {
      showView('me');
      document.querySelector('[data-career-kind="sources"]').click();
    }
    notice(typeof success === 'function' ? success(result) : success, op);
  }
  catch (error) { notice(error.message, 'error'); }
  finally { busy = false; controls.forEach((control, index) => { control.disabled = disabled[index]; }); window.backupsUI?.setBusy(false); await refresh(); }
}
// Browsers open their extension pages only when launched with them; if that fails, the exact address is shown to copy.
function extensionsPage(browser, result) {
  $(`${browser}-extensions-manual`).hidden = result.opened;
  return '';
}
for (const [id, op, message] of [
  ['connect-account', 'connect-account', result => result.pairingRequired ? 'Complete sign-in in the browser, then choose Open Companion and approve the account on this computer.' : ''],
  ['get-codex', 'get-codex', result => `${result.destination} opened in your browser.`],
  ['get-claude', 'get-claude', result => `${result.destination} opened in your browser.`],
  ['install-chatgpt', 'install-chatgpt', `Added to Codex. ${restartLine('codex')}`],
  ['copy-agent-prompt', 'copy-agent-prompt', 'Copied. Paste it into your agent and send.'],
  ['install-claude', 'install-claude', result => `${result?.mode === 'cli' ? 'Added to Claude Code.' : 'Added to Claude.'} ${restartLine('claude', result?.mode)}`],
  ['save-extension', 'save-extension', ''],
  ['save-firefox-extension', 'save-firefox-extension', ''],
  ['open-chrome-extensions', 'open-chrome-extensions', result => extensionsPage('chrome', result)],
  ['open-firefox-extensions', 'open-firefox-extensions', result => extensionsPage('firefox', result)],
  ['copy-chrome-extensions', 'copy-chrome-extensions', 'Copied.'],
  ['copy-firefox-extensions', 'copy-firefox-extensions', 'Copied.'],
  ['import-cv', 'import-cv', result => result.cancelled ? 'Import canceled.' : 'CV imported.'],
  ['copy-review-prompt', 'copy-review-prompt', 'Copied. Paste into your connected Codex or Claude conversation and send.'],
  ['review-codex', 'review-codex', result => result.mode === 'cli' ? 'Codex opened. Press Enter in that window to send the message.' : 'Codex opened. Send the message there to start the review.'],
  ['review-claude', 'review-claude', result => result.mode === 'cli' ? 'Claude opened. Press Enter in that window to send the message.' : 'Claude opened. Send the message there to start the review.'],
  ['setup-codex', 'review-codex', result => result.mode === 'cli' ? 'Codex opened. Press Enter in that window to send the message.' : 'Codex opened. Send the message there to start the review.'],
  ['setup-claude', 'review-claude', result => result.mode === 'cli' ? 'Claude opened. Press Enter in that window to send the message.' : 'Claude opened. Send the message there to start the review.'],
  ['delete-rankings', 'delete-rankings', 'Job reviews cleared.'],
  ['unlock', 'unlock', 'Your saved work is open.'],
]) $(id).addEventListener('click', () => { void action(op, message); });
for (const browser of ['chrome', 'firefox']) $(`copy-${browser}-browser-setup`).addEventListener('click', async () => {
  try { await navigator.clipboard.writeText($(`${browser}-browser-setup`).textContent); notice('Copied. Paste it into a terminal on this computer.', 'copy-browser-setup'); }
  catch { notice('Select the command and copy it.', 'error'); }
});
// GitHub linking is done on the website through the account sign-in. Only middleware's synchronized copy of the link counts,
// so the row reads the platform status rather than a local flag, and re-reads it when the window regains focus after linking.
let github = { paired: false, state: 'unknown', login: null };
let githubRequest = 0, githubPollUntil = 0;
function renderGithub() {
  const button = $('connect-github'), status = $('github-status');
  $('github-ask').hidden = github.state !== 'linked';
  if (!github.paired) {
    status.textContent = 'Connect your account first, then link GitHub.';
    button.hidden = true;
    return;
  }
  const text = {
    loading: 'Checking your GitHub link…',
    linked: `Linked as @${github.login}.`,
    unlinked: 'GitHub is not linked.',
    offline: 'Could not check your GitHub link. Check your internet connection and try again.',
    reconnect: 'Reconnect your account to check your GitHub link.',
    unknown: '',
  };
  status.textContent = text[github.state];
  button.hidden = false;
  button.textContent = github.state === 'linked' ? 'Manage on recruiters.rip' : 'Link GitHub';
  button.disabled = github.state === 'loading' || github.state === 'reconnect';
}
async function syncGithub(paired, force = false) {
  if (!paired) { github = { paired: false, state: 'unknown', login: null }; githubPollUntil = 0; renderGithub(); return; }
  if (!force && github.paired && github.state !== 'unknown') return;
  const request = ++githubRequest;
  if (github.state === 'unknown') { github = { paired: true, state: 'loading', login: null }; renderGithub(); }
  try {
    const result = await invoke('account-platform');
    if (request !== githubRequest) return;
    github = result.unavailable ? { paired: true, state: result.unavailable, login: null }
      : { paired: true, state: result.github?.login ? 'linked' : 'unlinked', login: result.github?.login ?? null };
  } catch { if (request === githubRequest) github = { paired: true, state: 'offline', login: null }; }
  renderGithub();
  // The website links instantly, but the platform learns of it through a webhook; keep checking briefly after a link attempt.
  if (github.state !== 'linked' && Date.now() < githubPollUntil) setTimeout(() => { void syncGithub(true, true); }, 4000);
}
$('connect-github').addEventListener('click', async () => {
  if (github.state === 'linked') { await action('connect-account', ''); return; }
  const button = $('connect-github');
  button.disabled = true;
  try {
    await invoke('connect-github');
    githubPollUntil = Date.now() + 3 * 60 * 1000;
    $('github-status').textContent = 'Choose Link GitHub on the recruiters.rip page that opened, then come back here.';
  } catch (error) { notice(error.message, 'error'); button.disabled = false; }
});
window.addEventListener('focus', () => { if (state?.paired) void syncGithub(true, true); });
async function answerApproval(allow) {
  const id = state?.approval?.id; if (!id) return;
  $('approval-cancel').disabled = true; $('approval-allow').disabled = true;
  try { await invoke('approval', { id, allow }); } catch (error) { notice(error.message, 'error'); }
  await refresh();
}
$('approval-cancel').addEventListener('click', () => { void answerApproval(false); });
$('approval-allow').addEventListener('click', () => { void answerApproval(true); });
$('approval-dialog').addEventListener('cancel', event => { event.preventDefault(); void answerApproval(false); });
window.companion.onState(() => { void refresh(); });
window.companion.onSettingsSection(section => { requestedSection = section; void refresh(); });
void refresh();
setInterval(() => { if (!busy && !document.hidden) void refresh(); }, 5000);
