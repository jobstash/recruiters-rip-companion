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
export function createNativeClient({ connect, host, randomUUID = () => crypto.randomUUID(), timeoutMs = 180000, maxPending = 4 }) {
  let port; const pending = new Map();
  const failAll = () => { port = null; for (const task of pending.values()) { clearTimeout(task.timer); task.reject(new Error('Open Recruiters.rip Companion, then try again.')); } pending.clear(); };
  function request(op, payload) {
    insist(['status','pair','open_settings','capture_jobs','forms_prepare','forms_cancel'].includes(op), 'This native operation is unavailable.');
    insist(pending.size < maxPending, 'The companion is busy. Cancel or finish the current request.');
    const id = randomUUID(), message = { version: 1, id, op, payload };
    insist(new TextEncoder().encode(JSON.stringify(message)).length <= 1024 * 1024, 'This page exceeds the capture limit. Select fewer jobs.');
    if (!port) {
      port = connect(host);
      const active = port;
      active.onMessage.addListener(message => {
        if (port !== active) return;
        const task = pending.get(message?.id); if (!task) return;
        pending.delete(message.id); clearTimeout(task.timer);
        if (message.version === 1 && message.ok === true) task.resolve(message.result);
        else task.reject(new Error(typeof message?.error?.message === 'string' ? message.error.message.slice(0, 400) : 'The companion did not authorize this operation. Try again.'));
      });
      active.onDisconnect.addListener(() => { if (port === active) failAll(); });
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('The companion request expired. Review the companion and try again.')); }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      try { port.postMessage(message); } catch (error) { pending.delete(id); clearTimeout(timer); reject(error); }
    });
  }
  return { request, disconnect() { const active = port; failAll(); active?.disconnect(); } };
}
