'use strict';
const $ = id => document.getElementById(id);
let state, busy = false, noticeKind = '', careerViewVersion, stateRequest = 0, view = null;
const notice = (text, kind = '') => { $('notice').textContent = text; noticeKind = kind; };
async function invoke(op, input = {}) { const response = await window.companion.invoke(op, input); if (!response.ok) throw new Error(response.error.message); return response.result; }
const views = ['me', 'jobs', 'setup', 'help'];
function showView(next) {
  view = next;
  for (const button of document.querySelectorAll('[data-view]')) {
    if (button.dataset.view === next) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current');
  }
  for (const name of views) $(`view-${name}`).hidden = name !== next;
  if (next !== 'setup') window.prescanUI?.clearInput();
}
for (const button of document.querySelectorAll('[data-view]')) button.addEventListener('click', () => showView(button.dataset.view));
function openSettings(target) {
  showView('setup');
  const section = $(target);
  section.scrollIntoView({ block: 'start' });
  section.querySelector('input:not(:disabled), button:not(:disabled)')?.focus({ preventScroll: true });
}
window.openCompanionSettings = openSettings;
$('me-account').addEventListener('click', () => openSettings('account-settings'));
$('me-chat-apps').addEventListener('click', () => openSettings('chat-app-settings'));
$('jobs-prescan-settings').addEventListener('click', () => openSettings('prescan'));
// Help reads the running package version from the same state snapshot Settings → Updates renders.
window.helpUI = {
  refresh(current) { $('help-version').textContent = typeof current?.updates?.version === 'string' ? `Version ${current.updates.version}` : ''; },
  clear() { $('help-version').textContent = ''; },
};
async function refresh() {
  const request = ++stateRequest;
  try {
    const current = await invoke('state');
    if (request !== stateRequest) return;
    state = current;
    const locked = state.execution.state === 'locked';
    $('storage').hidden = !locked; $('settings').hidden = locked; $('views').hidden = locked;
    $('storage-message').textContent = state.failure || 'Open local storage to see your saved career data.';
    if (state.approval && !locked) {
      $('approval-title').textContent = state.approval.title; $('approval-detail').textContent = state.approval.detail;
      $('approval-cancel').disabled = false; $('approval-allow').disabled = false;
      if (!$('approval-dialog').open) $('approval-dialog').showModal();
    } else if ($('approval-dialog').open) $('approval-dialog').close();
    if (locked) {
      $('mcp-command').textContent = ''; $('mcp-config').textContent = '';
      window.careerBrowser?.clear(); careerViewVersion = undefined;
      window.prescanUI?.clear();
      window.updatesUI?.clear();
      window.helpUI.clear();
      return;
    }
    $('connect-account').textContent = state.paired ? 'Open account' : 'Connect account';
    $('connect-account').classList.toggle('primary', !state.paired);
    $('connect-account').classList.toggle('ghost', state.paired);
    $('account-hint').textContent = state.paired ? 'Connected' : 'Not connected';
    $('me-account').hidden = state.paired;
    renderSharing(state.introductions);
    syncGithub(state.paired);
    if (!view) showView('me');
    if (state.paired && noticeKind === 'connect-account') notice('');
    if (window.careerBrowser && careerViewVersion !== state.careerViewVersion) {
      careerViewVersion = state.careerViewVersion;
      void window.careerBrowser.refresh();
    }
    $('mcp-command').textContent = state.setup.command; $('mcp-config').textContent = state.setup.claudeConfig;
    window.prescanUI?.refresh(state.prescan, state.paired);
    window.updatesUI?.refresh(state.updates);
    window.helpUI.refresh(state);
    if (state.failure) notice(state.failure);
  } catch {
    if (request !== stateRequest) return;
    window.careerBrowser?.clear(); careerViewVersion = undefined;
    window.prescanUI?.clear();
    window.updatesUI?.clear();
    window.helpUI.clear();
    notice('Could not load settings. Reopen the companion.');
  }
}
async function action(op, success) {
  if (busy) return;
  busy = true;
  // Browser instances manage their own controls; the Jobs toolbar's Copy review prompt is an ordinary action.
  const controls = [...document.querySelectorAll('button')].filter(button => (!button.closest('#me-browser, #career-browser, #views, #prescan, #prescan-controls, #update-settings') || button.id === 'copy-review-prompt') && !['approval-cancel', 'approval-allow'].includes(button.id));
  const disabled = controls.map(control => control.disabled); controls.forEach(control => { control.disabled = true; });
  try {
    const result = await invoke(op);
    if (op === 'import-cv' && !result.cancelled) {
      showView('me');
      document.querySelector('[data-career-kind="sources"]').click();
    }
    notice(typeof success === 'function' ? success(result) : success, op);
  }
  catch (error) { notice(error.message); }
  finally { busy = false; controls.forEach((control, index) => { control.disabled = disabled[index]; }); await refresh(); }
}
for (const [id, op, message] of [
  ['connect-account', 'connect-account', result => result.pairingRequired ? 'Complete sign-in and device pairing in the browser, then choose “Confirm account on this computer” to return here for approval.' : ''],
  ['install-chatgpt', 'install-chatgpt', result => `Recruiters.rip plugin configuration installed. ${result.conversationRequired}`],
  ['copy-command', 'copy-command', 'MCP command copied.'],
  ['copy-config', 'copy-config', 'Configuration copied.'],
  ['install-claude', 'install-claude', 'Approve the extension installation in Claude Desktop.'],
  ['open-extension-folder', 'open-extension-folder', 'Extension folder opened. In Chrome’s Manage extensions, enable Developer mode and choose Load unpacked.'],
  ['import-cv', 'import-cv', result => result.cancelled ? 'Import canceled.' : 'CV imported.'],
  ['copy-review-prompt', 'copy-review-prompt', 'Copied. Paste into Codex or Claude.'],
  ['open-exports', 'open-exports', 'Export folder opened.'],
  ['backup', 'backup', result => result.exported ? 'Backup exported.' : 'Export canceled.'],
  ['delete-rankings', 'delete-rankings', 'Job assessments cleared.'],
  ['unlock', 'unlock', 'Local storage is open.'],
]) $(id).addEventListener('click', () => { void action(op, message); });
// Sharing consent is standing but reversible: stopping blocks future uploads, and allowing again re-enables them.
const sharingDate = value => typeof value === 'string' && Number.isFinite(Date.parse(value))
  ? new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium' }).format(new Date(value)) : null;
function renderSharing(introductions) {
  const granted = introductions?.consent?.granted === true;
  const since = sharingDate(introductions?.consent?.at);
  $('sharing-status').textContent = granted ? `CV sharing is on${since ? ` since ${since}` : ''}. Each upload still asks for your approval.`
    : 'CV sharing is off. JobStash uses your CV and matched work history so you are included when it launches direct introductions.';
  const shared = (introductions?.sources ?? []).filter(source => source.sharedAt).sort((a, b) => b.sharedAt.localeCompare(a.sharedAt))[0];
  $('sharing-shared').hidden = !shared;
  $('sharing-shared').textContent = shared ? `Last shared ${shared.name} · ${shared.roles ?? 0} ${shared.roles === 1 ? 'role' : 'roles'} · ${sharingDate(shared.sharedAt)}` : '';
  $('sharing-toggle').textContent = granted ? 'Stop sharing' : 'Allow CV sharing';
}
// GitHub linking is done on the website through the account sign-in. Only middleware's synchronized copy of the link counts,
// so the row reads the platform status rather than a local flag, and re-reads it when the window regains focus after linking.
let github = { paired: false, state: 'unknown', login: null };
let githubRequest = 0, githubPollUntil = 0;
function renderGithub() {
  const row = $('github-row'), button = $('connect-github'), status = $('github-status');
  row.hidden = !github.paired;
  if (!github.paired) return;
  const text = {
    loading: 'Checking your GitHub link…',
    linked: `Linked as @${github.login}. JobStash can match your open-source work to you.`,
    unlinked: 'Not linked. Optional: developers with open-source work can link GitHub so JobStash can confirm those contributions are theirs.',
    offline: 'Could not reach the platform to check your GitHub link. Check your connection.',
    reconnect: 'Reconnect your account to check your GitHub link.',
    unknown: '',
  };
  status.textContent = text[github.state];
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
  } catch (error) { notice(error.message); button.disabled = false; }
});
window.addEventListener('focus', () => { if (state?.paired) void syncGithub(true, true); });
$('sharing-toggle').addEventListener('click', () => {
  const granted = state?.introductions?.consent?.granted === true;
  void action(granted ? 'sharing-stop' : 'sharing-allow', granted ? 'CV sharing stopped. Nothing new will be sent.' : 'CV sharing allowed.');
});
async function answerApproval(allow) {
  const id = state?.approval?.id; if (!id) return;
  $('approval-cancel').disabled = true; $('approval-allow').disabled = true;
  try { await invoke('approval', { id, allow }); } catch (error) { notice(error.message); }
  await refresh();
}
$('approval-cancel').addEventListener('click', () => { void answerApproval(false); });
$('approval-allow').addEventListener('click', () => { void answerApproval(true); });
$('approval-dialog').addEventListener('cancel', event => { event.preventDefault(); void answerApproval(false); });
window.companion.onState(() => { void refresh(); });
void refresh();
setInterval(() => { if (!busy && !document.hidden) void refresh(); }, 5000);
