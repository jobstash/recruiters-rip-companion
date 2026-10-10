import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cleanEnvironment } from './paths.mjs';
export const exec = promisify(execFile);
export async function openBrowser(url) {
  const parsed = new URL(url);
  if (!['https:', 'http:'].includes(parsed.protocol)) throw new Error('Unsupported browser address.');
  const [command, args] = process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['rundll32.exe', ['url.dll,FileProtocolHandler', url]] : ['xdg-open', [url]];
  await exec(command, args, { env: cleanEnvironment(), timeout: 10000 });
}
export function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env: cleanEnvironment(), stdio: 'inherit', ...options });
    let diagnostic = '';
    child.stderr?.on('data', chunk => { diagnostic = (diagnostic + chunk).slice(-4000); });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(diagnostic.trim() || `Command exited with status ${code}.`)));
  });
}
export async function npm(args, options = {}) {
  // npm_execpath avoids .cmd shell interpolation on Windows when invoked by npx.
  if (process.env.npm_execpath?.endsWith('.js')) return run(process.execPath, [process.env.npm_execpath, ...args], options);
  return run(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, { ...options, ...(process.platform === 'win32' ? { shell: true } : {}) });
}
