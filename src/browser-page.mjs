import { execFile, spawn } from 'node:child_process';
import path from 'node:path';

// Browsers only open their internal extension pages when launched with them, so Companion starts the browser itself.
// Every command and argument is fixed here; the renderer only names the browser by choosing an operation.
export const EXTENSIONS_PAGES = { chrome: 'chrome://extensions', firefox: 'about:debugging#/runtime/this-firefox' };

export function extensionsPageCommands(browser, { platform = process.platform, env = process.env } = {}) {
  const url = EXTENSIONS_PAGES[browser];
  if (!url) throw new Error('Unsupported browser.');
  if (platform === 'darwin') return [{ command: 'open', args: ['-a', browser === 'chrome' ? 'Google Chrome' : 'Firefox', url], wait: true }];
  if (platform === 'win32') {
    const roots = [env.ProgramFiles, env['ProgramFiles(x86)'], env.LOCALAPPDATA].filter(root => typeof root === 'string' && path.win32.isAbsolute(root));
    const relative = browser === 'chrome' ? ['Google', 'Chrome', 'Application', 'chrome.exe'] : ['Mozilla Firefox', 'firefox.exe'];
    return roots.map(root => ({ command: path.win32.join(root, ...relative), args: [url] }));
  }
  return (browser === 'chrome' ? ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser'] : ['firefox']).map(command => ({ command, args: [url] }));
}

// `open` reports a missing app through its exit code; a browser binary keeps running, so it is detached once started.
function launch({ command, args, wait }) {
  if (wait) return new Promise(resolve => { execFile(command, args, { timeout: 15000 }, error => resolve(!error)); });
  return new Promise(resolve => {
    const child = spawn(command, args, { detached: true, stdio: 'ignore' });
    child.once('error', () => resolve(false));
    child.once('spawn', () => { child.unref(); resolve(true); });
  });
}

export async function openExtensionsPage(browser, { platform, env, run = launch } = {}) {
  for (const candidate of extensionsPageCommands(browser, { platform, env }))
    if (await run(candidate)) return { opened: true, url: EXTENSIONS_PAGES[browser] };
  return { opened: false, url: EXTENSIONS_PAGES[browser] };
}
