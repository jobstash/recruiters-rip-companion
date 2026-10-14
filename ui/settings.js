'use strict';
const $ = id => document.getElementById(id);
let state, busy = false;
const notice = text => { $('notice').textContent = text; };
async function invoke(op, input = {}) { const response = await window.companion.invoke(op, input); if (!response.ok) throw new Error(response.error.message); return response.result; }
async function refresh() {
  try {
    state = await invoke('state');
    const locked = state.execution.state === 'locked';
    $('storage').hidden = !locked; $('settings').hidden = locked; $('toggle-updates').disabled = locked;
    $('storage-message').textContent = state.failure || 'Unlock operating system key storage to open your saved career data.';
    if (state.approval && !locked) {
      $('approval-title').textContent = state.approval.title; $('approval-detail').textContent = state.approval.detail;
      $('approval-cancel').disabled = false; $('approval-allow').disabled = false;
      if (!$('approval-dialog').open) $('approval-dialog').showModal();
    } else if ($('approval-dialog').open) $('approval-dialog').close();
    if (locked) { $('mcp-command').value = ''; $('mcp-config').textContent = ''; return; }
    $('account').textContent = state.paired ? `${state.account.label} · ${state.origin}` : '';
    $('account').hidden = !state.paired;
    $('account-state').textContent = state.paired ? 'Connected' : 'Not connected'; $('account-state').classList.toggle('is-on', Boolean(state.paired));
    $('connect-account').textContent = state.paired ? 'Open account connection' : 'Connect account';
    const updatesBlocked = state.execution.state === 'paused';
    $('toggle-updates').textContent = updatesBlocked ? 'Allow updates' : 'Block updates';
    $('updates-state').textContent = updatesBlocked ? 'Blocked' : 'Allowed';
    $('mcp-status').textContent = state.mcpConnections ? `${state.mcpConnections} connection${state.mcpConnections === 1 ? '' : 's'} open` : 'No chat app connected';
    $('mcp-status').classList.toggle('is-on', Boolean(state.mcpConnections));
    $('mcp-command').value = state.setup.command; $('mcp-config').textContent = state.setup.claudeConfig;
    $('career-counts').textContent = `${state.career.sources} sources · ${state.career.facts} facts · ${state.career.rankings ?? 0} rankings · ${state.career.applications} application drafts`;
    $('activity').textContent = state.lastTool ? `Last chat-app request · ${new Date(state.lastTool.at).toLocaleTimeString()}` : '';
    $('archive-status').textContent = state.archivedIdentities ? `${state.archivedIdentities} earlier device archive${state.archivedIdentities === 1 ? '' : 's'} included in career backups.` : 'No earlier device archives.';
    if (state.failure) notice(state.failure);
  } catch { notice('Local settings could not be read. Close and reopen the companion. Saved data has not been replaced.'); }
}
async function action(op, success) {
  if (busy) return;
  busy = true;
  const controls = [...document.querySelectorAll('button')].filter(button => !['approval-cancel', 'approval-allow'].includes(button.id));
  const disabled = controls.map(control => control.disabled); controls.forEach(control => { control.disabled = true; });
  try { const result = await invoke(op); notice(typeof success === 'function' ? success(result) : success); }
  catch (error) { notice(error.message); }
  finally { busy = false; controls.forEach((control, index) => { control.disabled = disabled[index]; }); await refresh(); }
}
$('toggle-updates').addEventListener('click', () => {
  const allow = state?.execution.state === 'paused';
  void action(allow ? 'resume' : 'pause', allow ? 'Local updates allowed.' : 'Local updates blocked.');
});
for (const [id, op, message] of [
  ['connect-account', 'connect-account', 'Complete account sign-in in the browser, then confirm the connection here.'],
  ['install-chatgpt', 'install-chatgpt', result => `Recruiters.rip plugin configuration installed. ${result.conversationRequired}`],
  ['copy-command', 'copy-command', 'MCP command copied. Register it as recruiters-rip in a compatible local MCP host.'],
  ['copy-config', 'copy-config', 'Configuration copied. Merge it with your existing Claude Desktop configuration.'],
  ['install-claude', 'install-claude', 'Approve the extension installation in Claude Desktop.'],
  ['open-exports', 'open-exports', 'Export folder opened.'],
  ['backup', 'backup', result => result.exported ? 'Career backup exported. It contains private data; keep it in a private location.' : 'Backup export canceled.'],
  ['delete-rankings', 'delete-rankings', 'Rankings deleted. Your profile and career facts are unchanged.'],
  ['install', 'install-native', 'Local connections repaired. Reconnect Recruiters.rip in your chat app.'],
  ['unlock', 'unlock', 'Local encrypted storage is open.'],
  ['unpair', 'unpair', 'A new device identity was created. Previous career data remains archived in local backups. Revoke the old device in your platform account.'],
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
