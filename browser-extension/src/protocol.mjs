const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const insist = (condition, message) => { if (!condition) throw new Error(message); };
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
export function safeDeviceRequest(message, productOrigin, now = Date.now()) {
  insist(exact(message, ['version','id','op','payload']) && message.version === 1 && uuid(message.id), 'Invalid device request.');
  insist(new TextEncoder().encode(JSON.stringify(message)).length <= 16384, 'Device request exceeds its size limit.');
  const p = message.payload;
  let valid = ['status','open_settings'].includes(message.op) && exact(p, []);
  if (message.op === 'pair') valid = exact(p, ['productOrigin','pairing']) && p.productOrigin === productOrigin && exact(p.pairing, ['deviceId','challenge','expiresAt','account']) && uuid(p.pairing.deviceId) && typeof p.pairing.challenge === 'string' && p.pairing.challenge.length > 0 && p.pairing.challenge.length <= 512 && typeof p.pairing.expiresAt === 'string' && Date.parse(p.pairing.expiresAt) > now && Date.parse(p.pairing.expiresAt) <= now + 301000 && exact(p.pairing.account, ['id','label']) && typeof p.pairing.account.id === 'string' && p.pairing.account.id.length > 0 && p.pairing.account.id.length <= 200 && typeof p.pairing.account.label === 'string' && p.pairing.account.label.length <= 240;
  insist(valid, 'This website device operation is not permitted.');
  return { op: message.op, payload: p };
}
export function externalSenderAllowed(port, productOrigin) {
  try { const s = port.sender; return port.name === 'recruiters-device' && new URL(s.url).origin === productOrigin && (!s.origin || s.origin === productOrigin) && Number.isInteger(s.tab?.id) && s.frameId === 0; } catch { return false; }
}
// Deliberately project account transport results: never forward a native corpus.
export function deviceResult(op, result) {
  if (op === 'open_settings') return { opened: result?.opened === true };
  const out = { installed: result?.installed === true, mode: 'local_mcp', paired: result?.paired === true, connections: [], execution: { state: ['locked','ready','needs_connection'].includes(result?.execution?.state) ? result.execution.state : 'needs_connection' } };
  for (const key of ['deviceId','publicKey','label']) if (typeof result?.[key] === 'string' && result[key].length <= 4096) out[key] = result[key];
  return out;
}
export function safeNativeCommand(message) {
  insist(exact(message, ['version','id','op','payload']) && message.version === 1 && uuid(message.id), 'Invalid browser command.');
  insist(new TextEncoder().encode(JSON.stringify(message)).length <= 1024 * 1024 - 1024, 'Browser command exceeds its size limit.');
  const p = message.payload;
  const text = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max;
  const valid = message.op === 'forms_status' && exact(p, ['formId']) && text(p.formId, 100);
  insist(valid, 'This browser command is invalid or unavailable.');
  return { op: message.op, payload: p };
}

// Keep application metadata separate from approved field values and native files.
export function applicationView(result) {
  const text = (value, max = 240) => typeof value === 'string' && value.length <= max ? value : null;
  const states = ['needs_job', 'needs_documents', 'needs_refresh', 'drafts', 'ready'];
  insist(text(result?.bindingId, 200) && states.includes(result?.state), 'Companion could not identify this application. Read page to try again.');
  const host = value => ['claude', 'codex'].includes(value) ? value : null;
  let jobUrl = null;
  try { const url = new URL(result.jobUrl); if (['https:', 'http:'].includes(url.protocol) && !url.username && !url.password) jobUrl = url.href; } catch { /* No known advert. */ }
  return {
    bindingId: result.bindingId, formId: text(result.formId, 200), applicationId: text(result.applicationId, 200),
    title: text(result.title) || 'This application', company: text(result.company), state: result.state,
    documents: ['cv', 'cover_letter'].map(kind => ({ kind, ready: result.documents?.some(doc => doc.kind === kind && doc.ready === true) === true, label: kind === 'cv' ? 'CV' : 'Cover letter' })),
    writing: (Array.isArray(result.writing) ? result.writing : []).slice(0, 64).map(field => ({ fieldId: text(field.fieldId, 200), label: text(field.label) || 'Written answer', ready: field.ready === true })),
    handoff: host(result.handoff?.host) && ['awaiting_agent', 'agent_read'].includes(result.handoff?.state)
      ? { host: result.handoff.host, state: result.handoff.state, requiresSend: result.handoff.requiresSend === true,
        ...(['desktop', 'cli'].includes(result.handoff.mode) ? { mode: result.handoff.mode } : {}) } : null,
    answerVersion: text(result.answerVersion, 200), jobUrl, preferredHost: host(result.preferredHost),
    ...(result.hostInfo && typeof result.hostInfo === 'object' ? {
      hostInfo: Object.fromEntries(['claude', 'codex'].filter(key => typeof result.hostInfo[key]?.available === 'boolean').map(key => [key, {
        available: result.hostInfo[key].available, label: text(result.hostInfo[key].label),
        mode: ['desktop', 'cli'].includes(result.hostInfo[key].mode) ? result.hostInfo[key].mode : null,
        reason: text(result.hostInfo[key].reason),
      }])),
    } : {}),
  };
}

// Companion-initiated read-only attachment checks arrive on the same port as
// `{version, id, op, payload}` and are answered with `{version, id, ok, result|error}`.
export function createNativeClient({ connect, host, onCommand = null, onDisconnect = null, randomUUID = () => crypto.randomUUID(), timeoutMs = 180000, maxPending = 4 }) {
  let port; const pending = new Map();
  const failAll = () => {
    const wasConnected = Boolean(port); port = null;
    for (const task of pending.values()) { clearTimeout(task.timer); task.reject(new Error('Open Recruiters.rip Companion, then try again.')); }
    pending.clear();
    if (wasConnected) { try { onDisconnect?.(); } catch { /* Disconnect cleanup must not strand requests. */ } }
  };
  function open() {
    if (port) return port;
    port = connect(host);
    const active = port, commands = new Set(), seenCommands = new Set();
    const send = reply => {
      if (port !== active) return;
      try { active.postMessage(reply); }
      catch { failAll(); try { active.disconnect(); } catch { /* Already disconnected. */ } }
    };
    const failed = (id, error) => ({ version: 1, id, ok: false, error: { message: String(error?.message || 'The browser could not complete this operation.').slice(0, 400) } });
    active.onMessage.addListener(message => {
      if (port !== active) return;
      if (message && Object.hasOwn(message, 'op')) {
        // Do not race an in-flight result with an error carrying the same ID.
        // The original command alone replies, and must never be dispatched twice.
        if (commands.has(message.id)) return;
        let command;
        try {
          command = safeNativeCommand(message);
          insist(onCommand && commands.size < maxPending, 'The browser is busy or unavailable.');
          insist(!seenCommands.has(message.id), 'This browser command was already received.');
        } catch (error) { if (uuid(message.id)) send(failed(message.id, error)); return; }
        commands.add(message.id); seenCommands.add(message.id);
        if (seenCommands.size > 256) seenCommands.delete(seenCommands.values().next().value);
        Promise.resolve().then(() => {
          insist(port === active, 'The companion disconnected before the operation.');
          return onCommand(command.op, command.payload);
        }).then(
          result => send({ version: 1, id: message.id, ok: true, result }),
          error => send(failed(message.id, error)),
        ).finally(() => commands.delete(message.id));
        return;
      }
      const task = pending.get(message?.id); if (!task) return;
      pending.delete(message.id); clearTimeout(task.timer);
      if (message.version === 1 && message.ok === true) task.resolve(message.result);
      else task.reject(new Error(typeof message?.error?.message === 'string' ? message.error.message.slice(0, 400) : 'The companion did not authorize this operation. Try again.'));
    });
    active.onDisconnect.addListener(() => { if (port === active) failAll(); });
    return active;
  }
  function request(op, payload) {
    insist(['status','pair','open_settings','open_decisions_settings','capture_jobs','forms_prepare','forms_profile_save','forms_cancel','forms_validate',
      'application_resolve','application_status','application_prepare','application_document','application_open_ad'].includes(op), 'This native operation is unavailable.');
    insist(pending.size < maxPending, 'The companion is busy. Cancel or finish the current request.');
    const id = randomUUID(), message = { version: 1, id, op, payload };
    insist(new TextEncoder().encode(JSON.stringify(message)).length <= 1024 * 1024, 'This page exceeds the capture limit. Select fewer jobs.');
    open();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('The companion request expired. Review the companion and try again.')); },
        op === 'forms_validate' ? Math.min(timeoutMs, 5000) : op === 'application_status' ? Math.min(timeoutMs, 10000) : timeoutMs);
      pending.set(id, { resolve, reject, timer });
      try { port.postMessage(message); } catch (error) {
        pending.delete(id); clearTimeout(timer); reject(error);
        const active = port; failAll(); try { active?.disconnect(); } catch { /* Already disconnected. */ }
      }
    });
  }
  return { request, connected: () => Boolean(port), disconnect() { const active = port; failAll(); try { active?.disconnect(); } catch { /* Already disconnected. */ } } };
}
