'use strict';
const $ = id => document.getElementById(id);
let state, busy = false;
const notice = text => { $('notice').textContent = text; };
async function invoke(op, input = {}) { const response = await window.companion.invoke(op, input); if (!response.ok) throw new Error(response.error.message); return response.result; }
async function refresh() {
  try {
    state = await invoke('state');
    const locked = state.execution.state === 'locked';
    $('storage').hidden = !locked; $('settings').hidden = locked; $('pause').disabled = locked;
    $('storage-message').textContent = state.failure || 'Unlock operating system key storage to open your saved career data.';
    if (state.approval && !locked) {
      $('approval-title').textContent = state.approval.title; $('approval-detail').textContent = state.approval.detail;
      $('approval-cancel').disabled = false; $('approval-allow').disabled = false;
      if (!$('approval-dialog').open) $('approval-dialog').showModal();
    } else if ($('approval-dialog').open) $('approval-dialog').close();
    if (locked) { $('mcp-command').value = ''; $('mcp-config').textContent = ''; return; }
    $('account').textContent = state.paired ? `${state.account.label} · ${state.origin}` : 'No platform account connected. Local profile tools are available; connect to use the job catalogue.';
    $('connect-account').textContent = state.paired ? 'Open account connection' : 'Connect account';
    $('pause').textContent = state.execution.state === 'paused' ? 'Resume work' : 'Pause work';
    $('execution').textContent = state.execution.state === 'paused' ? 'Local changes are paused. Saved records remain readable. Choose Resume work to continue.' : 'Ready for local career tools. Keep this app open while using your connected chat app.';
    $('mcp-status').textContent = state.mcpConnections ? `${state.mcpConnections} local MCP connection${state.mcpConnections === 1 ? '' : 's'} open.` : 'No chat app is connected yet.';
    $('mcp-command').value = state.setup.command; $('mcp-config').textContent = state.setup.claudeConfig;
    $('career-counts').textContent = `${state.career.sources} sources · ${state.career.facts} active facts · ${state.career.applications} applications`;
    $('activity').textContent = state.lastTool ? `Last completed tool: ${state.lastTool.name} at ${new Date(state.lastTool.at).toLocaleTimeString()}.` : 'Your conversation will show each saved change after a tool completes.';
    $('archive-status').textContent = state.archivedIdentities ? `${state.archivedIdentities} earlier device archive${state.archivedIdentities === 1 ? '' : 's'} included in career backups.` : 'No earlier device archives.';
    if (state.failure) notice(state.failure);
  } catch { notice('Local settings could not be read. Close and reopen the companion. Saved data has not been replaced.'); }
}
async function action(op, success) {
  if (busy) return;
  busy = true;
  const controls = [...document.querySelectorAll('button')].filter(button => !['pause', 'approval-cancel', 'approval-allow'].includes(button.id));
  const disabled = controls.map(control => control.disabled); controls.forEach(control => { control.disabled = true; });
  try { const result = await invoke(op); notice(typeof success === 'function' ? success(result) : success); }
  catch (error) { notice(error.message); }
  finally { busy = false; controls.forEach((control, index) => { control.disabled = disabled[index]; }); await refresh(); }
}
$('pause').addEventListener('click', async () => {
  const resume = state?.execution.state === 'paused';
  try { await invoke(resume ? 'resume' : 'pause'); notice(resume ? 'Local changes resumed.' : 'Local changes paused. Your chat app controls its own conversation and subscription usage.'); await refresh(); }
  catch { notice('Work state could not be changed. Quit this companion to disconnect local tools.'); }
});
for (const [id, op, message] of [
  ['connect-account', 'connect-account', 'Complete account sign-in in the browser, then confirm the connection here.'],
  ['install-chatgpt', 'install-chatgpt', result => `Recruiters.rip plugin configuration installed. ${result.conversationRequired}`],
  ['copy-command', 'copy-command', 'MCP command copied. Register it as recruiters-rip in a compatible local MCP host.'],
  ['copy-config', 'copy-config', 'Configuration copied. Merge it with your existing Claude Desktop configuration.'],
  ['install-claude', 'install-claude', 'Approve the extension installation in Claude Desktop.'],
  ['open-exports', 'open-exports', 'Your local exported PDF folder is open.'],
  ['backup', 'backup', result => result.exported ? 'Career backup exported. It contains private data; keep it in a private location.' : 'Backup export canceled.'],
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
