'use strict';
const $ = id => document.getElementById(id);
let state, busy = false, noticeKind = '', careerViewVersion, stateRequest = 0, view = null;
const notice = (text, kind = '') => { $('notice').textContent = text; noticeKind = kind; };
async function invoke(op, input = {}) { const response = await window.companion.invoke(op, input); if (!response.ok) throw new Error(response.error.message); return response.result; }
function showView(next) {
  view = next;
  for (const button of document.querySelectorAll('[data-view]')) {
    if (button.dataset.view === next) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current');
  }
  $('view-career').hidden = next !== 'career'; $('view-setup').hidden = next !== 'setup';
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
$('home-account').addEventListener('click', () => openSettings('account-settings'));
$('home-chat-apps').addEventListener('click', () => openSettings('chat-app-settings'));
$('home-prescan-settings').addEventListener('click', () => openSettings('prescan'));
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
      return;
    }
    $('connect-account').textContent = state.paired ? 'Open account' : 'Connect account';
    $('connect-account').classList.toggle('primary', !state.paired);
    $('connect-account').classList.toggle('ghost', state.paired);
    $('account-hint').textContent = state.paired ? 'Connected' : 'Not connected';
    $('home-account').hidden = state.paired;
    if (!view) showView('career');
    if (state.paired && noticeKind === 'connect-account') notice('');
    if (window.careerBrowser && careerViewVersion !== state.careerViewVersion) {
      careerViewVersion = state.careerViewVersion;
      void window.careerBrowser.refresh();
    }
    $('mcp-command').textContent = state.setup.command; $('mcp-config').textContent = state.setup.claudeConfig;
    window.prescanUI?.refresh(state.prescan, state.paired);
    if (state.failure) notice(state.failure);
  } catch {
    if (request !== stateRequest) return;
    window.careerBrowser?.clear(); careerViewVersion = undefined;
    window.prescanUI?.clear();
    notice('Local settings could not be read. Close and reopen the companion. Saved data has not been replaced.');
  }
}
async function action(op, success) {
  if (busy) return;
  busy = true;
  const controls = [...document.querySelectorAll('button')].filter(button => !button.closest('#career-browser, #views, #prescan, #prescan-controls') && !['approval-cancel', 'approval-allow'].includes(button.id));
  const disabled = controls.map(control => control.disabled); controls.forEach(control => { control.disabled = true; });
  try {
    const result = await invoke(op);
    if (op === 'import-cv' && !result.cancelled) {
      showView('career');
      document.querySelector('[data-career-kind="sources"]').click();
    }
    notice(typeof success === 'function' ? success(result) : success, op);
  }
  catch (error) { notice(error.message); }
  finally { busy = false; controls.forEach((control, index) => { control.disabled = disabled[index]; }); await refresh(); }
}
for (const [id, op, message] of [
  ['connect-account', 'connect-account', result => result.pairingRequired ? 'Complete account sign-in in the browser, then confirm the connection here.' : ''],
  ['install-chatgpt', 'install-chatgpt', result => `Recruiters.rip plugin configuration installed. ${result.conversationRequired}`],
  ['copy-command', 'copy-command', 'MCP command copied. Register it as recruiters-rip in a compatible local MCP host.'],
  ['copy-config', 'copy-config', 'Configuration copied. Merge it with your existing Claude Desktop configuration.'],
  ['install-claude', 'install-claude', 'Approve the extension installation in Claude Desktop.'],
  ['import-cv', 'import-cv', result => result.cancelled ? 'Import canceled.' : 'CV imported.'],
  ['copy-review-prompt', 'copy-review-prompt', 'Copied. Paste into Codex or Claude with recruiters.rip enabled. Review has not started.'],
  ['open-exports', 'open-exports', 'Export folder opened.'],
  ['backup', 'backup', result => result.exported ? 'Backup exported. Keep it private.' : 'Export canceled.'],
  ['delete-rankings', 'delete-rankings', 'Job assessments cleared. CVs, facts and job applications kept.'],
  ['unlock', 'unlock', 'Local storage is open.'],
]) $(id).addEventListener('click', () => { void action(op, message); });
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
