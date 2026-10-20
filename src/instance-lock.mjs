import { createHash } from 'node:crypto';
import { closeSync, constants, mkdirSync, openSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';

// macOS O_EXLOCK from <sys/fcntl.h>; Node does not export it. The kernel drops the lock when the process exits or dies.
const DARWIN_O_EXLOCK = 0x20;

/**
 * Claim the single running companion for a storage directory. Electron's singleton lock let two MCP launches started in
 * the same instant both run, each serving its own in-memory vault, so this kernel-held lock is the authority.
 * Resolves to a release function, or null when another live process holds the claim. Crashes never leave it stale.
 */
export async function claimInstance(directory) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (process.platform === 'darwin') {
    let fd;
    try { fd = openSync(path.join(directory, 'instance.lock'), constants.O_CREAT | constants.O_RDWR | constants.O_NONBLOCK | DARWIN_O_EXLOCK, 0o600); }
    catch (error) { if (error.code === 'EAGAIN' || error.code === 'EWOULDBLOCK') return null; throw error; }
    return () => closeSync(fd);
  }
  // Linux: an abstract socket name is claimed atomically and disappears with its process.
  const name = `\0recruiters-companion-${createHash('sha256').update(path.resolve(directory)).digest('hex').slice(0, 32)}`;
  const server = net.createServer(socket => socket.destroy());
  try { await new Promise((resolve, reject) => { server.once('error', reject); server.listen(name, resolve); }); }
  catch (error) { if (error.code === 'EADDRINUSE') return null; throw error; }
  server.unref();
  return () => server.close();
}
