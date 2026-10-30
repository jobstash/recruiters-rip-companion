import test from 'node:test';
import assert from 'node:assert/strict';
import { extensionsPageCommands, openExtensionsPage } from '../src/browser-page.mjs';

test('each OS launches the browser itself with its fixed extensions page', () => {
  assert.deepEqual(extensionsPageCommands('chrome', { platform: 'darwin' }), [{ command: 'open', args: ['-a', 'Google Chrome', 'chrome://extensions'], wait: true }]);
  assert.deepEqual(extensionsPageCommands('firefox', { platform: 'darwin' }), [{ command: 'open', args: ['-a', 'Firefox', 'about:debugging#/runtime/this-firefox'], wait: true }]);
  const env = { ProgramFiles: 'C:\\Program Files', 'ProgramFiles(x86)': 'C:\\Program Files (x86)', LOCALAPPDATA: 'relative\\ignored' };
  assert.deepEqual(extensionsPageCommands('chrome', { platform: 'win32', env }).map(({ command }) => command),
    ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe']);
  assert.deepEqual(extensionsPageCommands('firefox', { platform: 'win32', env })[0], { command: 'C:\\Program Files\\Mozilla Firefox\\firefox.exe', args: ['about:debugging#/runtime/this-firefox'] });
  assert.deepEqual(extensionsPageCommands('chrome', { platform: 'linux' }).map(({ command }) => command), ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']);
  assert.deepEqual(extensionsPageCommands('firefox', { platform: 'linux' }), [{ command: 'firefox', args: ['about:debugging#/runtime/this-firefox'] }]);
  assert.throws(() => extensionsPageCommands('https://example.test', { platform: 'linux' }));
});

test('the first browser that starts wins; none starting reports the address to copy', async () => {
  const tried = [];
  assert.deepEqual(await openExtensionsPage('chrome', { platform: 'linux', run: async ({ command }) => { tried.push(command); return command === 'chromium'; } }),
    { opened: true, url: 'chrome://extensions' });
  assert.deepEqual(tried, ['google-chrome', 'google-chrome-stable', 'chromium']);
  assert.deepEqual(await openExtensionsPage('firefox', { platform: 'darwin', run: async () => false }), { opened: false, url: 'about:debugging#/runtime/this-firefox' });
});
