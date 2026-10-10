import net from 'node:net';
import path from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { writeFile, chmod, unlink } from 'node:fs/promises';
import { privateDirectory } from '../vault.mjs';

import { mcpSocket } from '../node/paths.mjs';

const MAX_FRAME = 16 * 1024 * 1024;
export async function startMcpBroker({ directory, createServer, onConnections = () => {} }) {
  await privateDirectory(directory);
  const socketPath = mcpSocket(directory);
  try { await unlink(socketPath); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const token = randomBytes(32).toString('hex');
  const clients = new Set();
  const listener = net.createServer(socket => {
    let input = Buffer.alloc(0), authenticated = false, transport, server;
    const timer = setTimeout(() => socket.destroy(), 5000);
    const close = () => {
      clearTimeout(timer); clients.delete(socket); onConnections(clients.size);
      transport?.onclose?.(); void server?.close();
    };
    socket.once('close', close);
    socket.on('error', error => transport?.onerror?.(error));
    let messages = Promise.resolve();
    socket.on('data', chunk => {
      input = Buffer.concat([input, chunk]);
      if (input.length > MAX_FRAME) { socket.destroy(); return; }
      for (;;) {
        const index = input.indexOf(10); if (index < 0) break;
        const line = input.subarray(0, index); input = input.subarray(index + 1);
        if (!line.length) continue;
        let message;
        try { message = JSON.parse(line.toString('utf8')); } catch { socket.destroy(); return; }
        messages = messages.then(async () => {
          if (socket.destroyed) return;
          if (!authenticated) {
            const value = typeof message.auth === 'string' ? Buffer.from(message.auth) : Buffer.alloc(0);
            if (Object.keys(message).length !== 1 || value.length !== token.length || !timingSafeEqual(value, Buffer.from(token))) { socket.destroy(); return; }
            authenticated = true; clearTimeout(timer);
            transport = {
              async start() {},
              async send(response) {
                const bytes = JSON.stringify(response) + '\n';
                if (Buffer.byteLength(bytes) > MAX_FRAME || socket.destroyed) throw new Error('Local MCP connection closed.');
                await new Promise((resolve, reject) => socket.write(bytes, error => error ? reject(error) : resolve()));
              },
              async close() { socket.destroy(); },
            };
            server = createServer(); await server.connect(transport);
            clients.add(socket); onConnections(clients.size); return;
          }
          transport.onmessage?.(message);
        }).catch(() => socket.destroy());
      }
    });
  });
  await new Promise((resolve, reject) => { listener.once('error', reject); listener.listen(socketPath, resolve); });
  if (process.platform !== 'win32') await chmod(socketPath, 0o600);
  const config = path.join(directory, 'mcp-bridge.json');
  await writeFile(config, JSON.stringify({ socket: socketPath, token }), { mode: 0o600 });
  await chmod(config, 0o600);
  return {
    disconnect() { for (const socket of clients) socket.destroy(); },
    close() { for (const socket of clients) socket.destroy(); return new Promise(resolve => listener.close(resolve)); },
  };
}
