import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const assets = new Map([
  ['design-tokens.css', 'text/css'], ['settings.css', 'text/css'],
  ['brand/recruiters-rip-lockup-reversed.svg', 'image/svg+xml'],
  ...['Geist-Regular', 'Geist-Medium', 'Geist-SemiBold', 'GeistMono-Regular', 'GeistMono-Medium', 'GeistMono-SemiBold', 'InstrumentSerif-Regular'].map(name => [`fonts/${name}.woff2`, 'font/woff2']),
].map(([name, type]) => [`/${name}`, { file: new URL(`../ui/${name}`, import.meta.url), type }]));

function returnPage(nonce) {
  return `<!doctype html><html lang="en" data-theme="dark"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Account connection · Recruiters.rip Companion</title><link rel="stylesheet" href="/design-tokens.css"><link rel="stylesheet" href="/settings.css"></head><body><header class="topbar"><div class="brand"><img class="brand-lockup" src="/brand/recruiters-rip-lockup-reversed.svg" alt="recruiters.rip" width="180" height="32"><span class="brand-sub">Companion</span></div></header><main><div class="page-heading"><h1 id="title">Account connection</h1><p id="status" role="status" aria-live="polite">Keep the companion open to finish connecting your account.</p><noscript>Enable JavaScript, then choose Connect account again in the companion.</noscript></div></main><script nonce="${nonce}">
(async () => {
  const fragment = new URLSearchParams(location.hash.slice(1));
  const state = fragment.get('state'), payload = fragment.get('payload');
  history.replaceState(null, '', '/pair');
  const title = document.getElementById('title'), status = document.getElementById('status');
  if (!state || !payload) { title.textContent = 'Start a new connection'; status.textContent = 'This return link is incomplete or was already used. Choose Connect account again in the companion.'; return; }
  title.textContent = 'Approve the account in the companion';
  status.textContent = 'Return to Recruiters.rip Companion and review the account shown in its approval dialog. This page will confirm when the connection is complete.';
  try {
    const response = await fetch('/pair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ state, payload }) });
    if (!response.ok) throw new Error();
    title.textContent = 'Account connected';
    status.textContent = 'You approved the account in Recruiters.rip Companion. You can close this tab and return to the app.';
  } catch {
    title.textContent = 'Account connection not completed';
    status.textContent = 'Return to the companion for details. If you cancelled or the request expired, choose Connect account again and create a new pairing request.';
  }
})();
</script></body></html>`;
}

/** A browser return transports a challenge; only onPair can request native approval and activate it. */
export async function startPairingReturn({ onPair }) {
  const state = randomBytes(32).toString('base64url');
  const expiresAt = Date.now() + 5 * 60_000;
  let origin, host, consumed = false, closed = false;
  const server = createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    function reply(code, body = '') { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); }
    if (req.headers.host !== host) { reply(403); return; }
    try {
      const asset = assets.get(req.url);
      if (req.method === 'GET' && asset) {
        const content = await readFile(fileURLToPath(asset.file));
        res.writeHead(200, { 'Content-Type': asset.type }); res.end(content); return;
      }
      if (req.url !== '/pair') { reply(404); return; }
      if (req.method === 'GET') {
        const nonce = randomBytes(18).toString('base64url');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'` });
        res.end(returnPage(nonce)); return;
      }
      if (req.method !== 'POST') { reply(405); return; }
      if (req.headers.origin !== origin || req.headers['content-type'] !== 'application/json') { reply(403); return; }
      const chunks = []; let bytes = 0;
      for await (const chunk of req.iterator({ destroyOnReturn: false })) {
        bytes += chunk.length;
        if (bytes > 12 * 1024) { res.setHeader('Connection', 'close'); reply(413); req.resume(); return; }
        chunks.push(chunk);
      }
      let body, payload;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 2 || typeof body.state !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(body.state) || typeof body.payload !== 'string' || !/^[A-Za-z0-9_-]{1,8192}$/.test(body.payload)) { reply(400); return; }
        payload = JSON.parse(Buffer.from(body.payload, 'base64url').toString('utf8'));
      } catch { reply(400); return; }
      if (consumed || Date.now() >= expiresAt || !timingSafeEqual(Buffer.from(body.state), Buffer.from(state))) { reply(403); return; }
      consumed = true;
      try { await onPair(payload); reply(200, { ok: true }); }
      catch { reply(409, { ok: false }); }
    } catch { if (!res.headersSent) reply(500); else res.end(); }
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  host = `127.0.0.1:${server.address().port}`; origin = `http://${host}`;
  function close() { if (closed) return; closed = true; clearTimeout(timer); server.close(); server.closeAllConnections(); }
  const timer = setTimeout(close, 5 * 60_000); timer.unref(); server.unref();
  return { companionReturn: `${origin}/pair`, companionState: state, close };
}
