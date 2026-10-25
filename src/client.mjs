import { createHash, randomUUID, sign as edSign } from 'node:crypto';

export const PRODUCT_ORIGINS = Object.freeze(['https://recruiters.rip', 'http://127.0.0.1:3001']);
export function canonicalJSON(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJSON).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJSON(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
async function rejectionReason(response) {
  let text = '';
  try {
    for await (const chunk of response.body ?? []) { text += Buffer.from(chunk).toString('utf8'); if (text.length > 4096) break; }
    const body = JSON.parse(text);
    const reason = typeof body?.message === 'string' ? body.message : typeof body?.error === 'string' ? body.error : '';
    return reason.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 200);
  } catch { return ''; } finally { await response.body?.cancel().catch(() => {}); }
}
export function createDeviceClient(store, localOnly) {
  const originAllowed = origin => origin === PRODUCT_ORIGINS[localOnly ? 1 : 0];
  // The CV share carries a ≤5 MiB document as base64 JSON; every other device route stays within 16 KiB.
  const limits = { '/device/activate': 16 * 1024, '/device/heartbeat': 16 * 1024, '/device/platform': 16 * 1024, '/device/cv': 7.5 * 1024 * 1024 };
  async function request(method, backendPath, body, options = {}) {
    if (!['GET', 'POST'].includes(method) || !Object.hasOwn(limits, backendPath)) throw new Error('Device operation is unavailable.');
    const state = store.get();
    const origin = options.origin ?? state.pairing?.origin;
    if (!originAllowed(origin)) throw new Error('Pair this computer with recruiters.rip.');
    const raw = method === 'GET' ? '' : JSON.stringify(body ?? {});
    if (Buffer.byteLength(raw) > limits[backendPath]) throw new Error(backendPath === '/device/cv' ? 'The CV upload exceeds the 7.5 MiB transfer limit.' : 'The request exceeds the 16 KiB device transfer limit.');
    const timeout = backendPath === '/device/cv' ? 120_000 : 30_000;
    const time = String(Date.now());
    const nonce = randomUUID();
    const canonical = `${time}\n${nonce}\n${method}\n${backendPath}\n${createHash('sha256').update(raw).digest('hex')}`;
    const signature = edSign(null, Buffer.from(canonical), state.privateKey).toString('base64url');
    let response;
    try {
      response = await fetch(`${origin}/api${backendPath}`, { method, redirect: 'error', headers: { 'Content-Type': 'application/json', 'X-Device-Id': state.deviceId, 'X-Device-Time': time, 'X-Device-Nonce': nonce, 'X-Device-Signature': signature }, ...(method === 'POST' ? { body: raw } : {}), signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout) });
    } catch { const error = new Error('Could not reach the platform. Check your connection.'); error.code = 'DEVICE_OFFLINE'; throw error; }
    if (!response.ok) {
      const reason = await rejectionReason(response);
      const error = new Error(`${response.status === 403
        ? 'Check your membership and account connection.'
        : response.status === 401 ? 'Reconnect your account in companion settings.'
        : 'The product could not accept this device operation.'} Platform (${response.status})${reason ? `: ${reason}` : '.'}`);
      error.status = response.status; error.code = response.status === 401 || response.status === 403 ? 'DEVICE_UNAUTHORIZED' : 'DEVICE_REQUEST_FAILED'; throw error;
    }
    let size = 0; const chunks = [];
    for await (const chunk of response.body) { size += chunk.length; if (size > 8 * 1024 * 1024) throw new Error('The device response exceeds the 8 MiB transfer limit.'); chunks.push(chunk); }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new Error('The product returned an unreadable device response.'); }
  }
  return { request, originAllowed };
}
