import net from 'node:net';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { writeFile, chmod, unlink } from 'node:fs/promises';
import { privateDirectory } from '../vault.mjs';
import { endpoint, protectPrivatePath, createAuthenticationChallenge, verifyAuthenticationProof } from '../platform-runtime.cjs';

const MAX_FRAME = 16 * 1024 * 1024;
/** onConnections receives the client name each open session declared in its MCP initialize request ('' until it does). */
export async function startMcpBroker({ directory, createServer, onConnections = () => {} }) {
  await privateDirectory(directory);
  const socketPath = endpoint(directory, 'mcp');
  if (process.platform !== 'win32') await privateDirectory(path.dirname(socketPath));
  if (process.platform !== 'win32') try { await unlink(socketPath); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const token = randomBytes(32).toString('hex');
  const clients = new Map();
  const report = () => onConnections([...clients.values()]);
  const listener = net.createServer(socket => {
    let input = Buffer.alloc(0), authenticated = false, transport, server, challenge;
    const timer = setTimeout(() => socket.destroy(), 5000);
    const close = () => {
      clearTimeout(timer); if (clients.delete(socket)) report();
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
            if (!challenge) {
              challenge = createAuthenticationChallenge(token, 'mcp', message);
              socket.write(JSON.stringify(challenge.message) + '\n'); return;
            }
            if (!message || Object.keys(message).length !== 1 || !verifyAuthenticationProof(token, 'client', 'mcp', challenge, message.authProof)) { socket.destroy(); return; }
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
            clients.set(socket, ''); report(); return;
          }
          if (message?.method === 'initialize' && clients.get(socket) === '') {
            const name = message.params?.clientInfo?.name;
            if (typeof name === 'string') { clients.set(socket, name.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 80)); report(); }
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
  protectPrivatePath(config);
  return {
    disconnect() { for (const socket of clients.keys()) socket.destroy(); },
    close() { for (const socket of clients.keys()) socket.destroy(); listener.close(); },
  };
}
