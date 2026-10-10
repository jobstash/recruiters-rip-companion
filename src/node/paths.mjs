import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export function paths({ home = os.homedir(), platform = process.platform, localOnly = false } = {}) {
  const support = platform === 'darwin' ? path.join(home, 'Library/Application Support') : platform === 'win32' ? (process.env.APPDATA || path.join(home, 'AppData/Roaming')) : (process.env.XDG_CONFIG_HOME || path.join(home, '.config'));
  const base = path.join(support, 'Recruiters Companion');
  const directory = path.join(base, localOnly ? 'local-device' : 'device');
  return { base, directory, runtime: path.join(base, 'node-runtime'), control: path.join(directory, 'node-control.json'), lock: path.join(directory, 'node.lock'), localOnly };
}
export function mcpSocket(directory) {
  return process.platform === 'win32' ? `\\\\.\\pipe\\recruiters-${createHash('sha256').update(directory).digest('hex').slice(0, 24)}` : path.join(directory, 'mcp.sock');
}
export function cleanEnvironment() {
  return Object.fromEntries(['PATH','HOME','USERPROFILE','APPDATA','LOCALAPPDATA','SystemRoot','COMSPEC','PATHEXT','TMPDIR','TMP','TEMP','USER','LOGNAME','XDG_CONFIG_HOME','DISPLAY','WAYLAND_DISPLAY','DBUS_SESSION_BUS_ADDRESS','XDG_RUNTIME_DIR','XDG_SESSION_ID','CODEX_HOME'].filter(key => process.env[key]).map(key => [key, process.env[key]]));
}
