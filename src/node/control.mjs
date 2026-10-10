import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile, writeFile, chmod, unlink } from 'node:fs/promises';
import path from 'node:path';
import { root } from './paths.mjs';
const equal = (a, b) => typeof a === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
export async function controlServer({ paths, invoke, pair, pairingState, fileSelection }) {
  const token = randomBytes(32).toString('hex'); let origin;
  const server = http.createServer(async (req, res) => {
    const send = (status, data, type = 'application/json') => { res.writeHead(status, { 'Content-Type': type }); res.end(type === 'application/json' ? JSON.stringify(data) : data); };
    res.setHeader('Cache-Control','no-store'); res.setHeader('Referrer-Policy','no-referrer'); res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; frame-ancestors 'none'; form-action 'none'; base-uri 'none'");
    try {
      if (req.headers.host !== new URL(origin).host) return send(403, { error: 'Local connections only.' });
      const url = new URL(req.url, origin);
      if (req.method === 'GET' && ['/', '/pair', '/settings.js', '/settings.css'].includes(url.pathname)) {
        const name = url.pathname === '/' || url.pathname === '/pair' ? 'index.html' : url.pathname.slice(1);
        return send(200, await readFile(path.join(root, 'ui', name)), name.endsWith('.js') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' : 'text/html');
      }
      if (req.method !== 'POST' || req.headers.origin && req.headers.origin !== origin || req.headers['sec-fetch-site'] && req.headers['sec-fetch-site'] !== 'same-origin' || !req.headers['content-type']?.startsWith('application/json')) return send(403, { error: 'Open the companion control page on this computer.' });
      const authorization = req.headers.authorization?.replace(/^Bearer /, '');
      // The website may only hand over a challenge bound to a one-time local state.
      const handoff = url.pathname === '/pair';
      if (!handoff && !equal(authorization, token)) return send(401, { error: 'Run recruiters open to open your controls.' });
      let size = 0, chunks = [];
      for await (const chunk of req) { size += chunk.length; if (size > 8 * 1024 * 1024) { send(413,{error:'Choose a CV smaller than 5 MiB.'}); req.destroy(); return; } chunks.push(chunk); }
      const body = JSON.parse(Buffer.concat(chunks).toString());
      if (handoff) {
        if (!pairingState(body.state)) return send(403,{error:'This pairing link expired. Open Connect account again.'});
        void pair(body.payload).catch(() => {});
        return send(200,{ok:true,result:{pending:true}});
      }
      if (url.pathname === '/source') return send(200, { ok: true, result: await fileSelection(body) });
      if (url.pathname !== '/action') return send(404,{error:'Not found.'});
      const result = await invoke(body.op, body.input ?? {});
      return send(200, { ok: true, result });
    } catch (e) { return send(400, { ok:false, error: { message: e.publicMessage || e.message || 'This action could not be completed.' } }); }
  });
  server.requestTimeout = 30000; server.headersTimeout = 10000;
  await new Promise((resolve,reject) => { server.once('error',reject); server.listen(0,'127.0.0.1', resolve); });
  origin = `http://127.0.0.1:${server.address().port}`;
  await writeFile(paths.control, JSON.stringify({ origin, token, pid: process.pid }), { mode: 0o600 }); await chmod(paths.control,0o600);
  return { origin, url: `${origin}/#token=${token}`, close: async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await unlink(paths.control).catch(()=>{}); } };
}
