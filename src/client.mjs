import { createHash, randomUUID, sign as edSign } from 'node:crypto';

export const PRODUCT_ORIGINS = Object.freeze(['https://recruiters.rip', 'http://127.0.0.1:3001']);
export function canonicalJSON(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJSON).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJSON(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
export function createDeviceClient(store, localOnly) {
  const originAllowed = origin => origin === PRODUCT_ORIGINS[localOnly ? 1 : 0];
  async function request(method, backendPath, body, options = {}) {
    if (!['GET', 'POST'].includes(method) || !/^\/device\/(?:activate|heartbeat|platform)$/.test(backendPath)) throw new Error('Device operation is unavailable.');
    const state = store.get();
    const origin = options.origin ?? state.pairing?.origin;
    if (!originAllowed(origin)) throw new Error('Pair this computer with recruiters.rip.');
    const raw = method === 'GET' ? '' : JSON.stringify(body ?? {});
    if (Buffer.byteLength(raw) > 16 * 1024) throw new Error('The request exceeds the 16 KiB device transfer limit.');
    const time = String(Date.now());
    const nonce = randomUUID();
    const canonical = `${time}\n${nonce}\n${method}\n${backendPath}\n${createHash('sha256').update(raw).digest('hex')}`;
    const signature = edSign(null, Buffer.from(canonical), state.privateKey).toString('base64url');
    let response;
    try {
      response = await fetch(`${origin}/api${backendPath}`, { method, redirect: 'error', headers: { 'Content-Type': 'application/json', 'X-Device-Id': state.deviceId, 'X-Device-Time': time, 'X-Device-Nonce': nonce, 'X-Device-Signature': signature }, ...(method === 'POST' ? { body: raw } : {}), signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000) });
    } catch { const error = new Error('The product is unreachable. Completed local results remain saved.'); error.code = 'DEVICE_OFFLINE'; throw error; }
    if (!response.ok) {
      await response.body?.cancel();
      const error = new Error(response.status === 403
        ? 'New platform data is unavailable. Check your paid membership or device connection. Your local profile and saved matches remain available.'
        : response.status === 401 ? 'Device authorization is unavailable. Check your pairing. Your local data remains available.'
        : 'The product could not accept this device operation.');
      error.status = response.status; error.code = response.status === 401 || response.status === 403 ? 'DEVICE_UNAUTHORIZED' : 'DEVICE_REQUEST_FAILED'; throw error;
    }
    let size = 0; const chunks = [];
    for await (const chunk of response.body) { size += chunk.length; if (size > 8 * 1024 * 1024) throw new Error('The device response exceeds the 8 MiB transfer limit.'); chunks.push(chunk); }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new Error('The product returned an unreadable device response.'); }
  }
  return { request, originAllowed };
}
