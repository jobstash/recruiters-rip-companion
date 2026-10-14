'use strict';
const $ = id => document.getElementById(id);
let state, busy = false, noticeKind = '', careerViewVersion, stateRequest = 0;
const notice = (text, kind = '') => { $('notice').textContent = text; noticeKind = kind; };
async function invoke(op, input = {}) { const response = await window.companion.invoke(op, input); if (!response.ok) throw new Error(response.error.message); return response.result; }
async function refresh() {
  const request = ++stateRequest;
  try {
    const current = await invoke('state');
    if (request !== stateRequest) return;
    state = current;
    const locked = state.execution.state === 'locked';
    $('storage').hidden = !locked; $('settings').hidden = locked;
    $('storage-message').textContent = state.failure || 'Unlock operating system key storage to open your saved career data.';
    if (state.approval && !locked) {
      $('approval-title').textContent = state.approval.title; $('approval-detail').textContent = state.approval.detail;
      $('approval-cancel').disabled = false; $('approval-allow').disabled = false;
      if (!$('approval-dialog').open) $('approval-dialog').showModal();
    } else if ($('approval-dialog').open) $('approval-dialog').close();
    if (locked) {
      $('mcp-command').value = ''; $('mcp-config').textContent = '';
      window.careerBrowser?.clear(); careerViewVersion = undefined;
      return;
    }
    $('connect-account').textContent = state.paired ? 'Open account' : 'Connect account';
    if (state.paired && noticeKind === 'connect-account') notice('');
    if (window.careerBrowser && careerViewVersion !== state.careerViewVersion) {
      careerViewVersion = state.careerViewVersion;
      void window.careerBrowser.refresh();
    }
    $('mcp-command').value = state.setup.command; $('mcp-config').textContent = state.setup.claudeConfig;
    if (state.failure) notice(state.failure);
  } catch {
    if (request !== stateRequest) return;
    window.careerBrowser?.clear(); careerViewVersion = undefined;
    notice('Local settings could not be read. Close and reopen the companion. Saved data has not been replaced.');
  }
}
async function action(op, success) {
  if (busy) return;
  busy = true;
  const controls = [...document.querySelectorAll('button')].filter(button => !button.closest('#career-browser') && !['approval-cancel', 'approval-allow'].includes(button.id));
  const disabled = controls.map(control => control.disabled); controls.forEach(control => { control.disabled = true; });
  try { const result = await invoke(op); notice(typeof success === 'function' ? success(result) : success, op); }
  catch (error) { notice(error.message); }
  finally { busy = false; controls.forEach((control, index) => { control.disabled = disabled[index]; }); await refresh(); }
}
for (const [id, op, message] of [
  ['connect-account', 'connect-account', result => result.pairingRequired ? 'Complete account sign-in in the browser, then confirm the connection here.' : ''],
  ['install-chatgpt', 'install-chatgpt', result => `Recruiters.rip plugin configuration installed. ${result.conversationRequired}`],
  ['copy-command', 'copy-command', 'MCP command copied. Register it as recruiters-rip in a compatible local MCP host.'],
  ['copy-config', 'copy-config', 'Configuration copied. Merge it with your existing Claude Desktop configuration.'],
  ['install-claude', 'install-claude', 'Approve the extension installation in Claude Desktop.'],
  ['open-exports', 'open-exports', 'Export folder opened.'],
  ['backup', 'backup', result => result.exported ? 'Career backup exported. It contains private data; keep it in a private location.' : 'Backup export canceled.'],
  ['delete-rankings', 'delete-rankings', 'Rankings deleted. Your profile and career facts are unchanged.'],
  ['unlock', 'unlock', 'Local encrypted storage is open.'],
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
