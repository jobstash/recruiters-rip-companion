'use strict';
const { contextBridge, ipcRenderer } = require('electron');
const allowed = new Set(['state', 'unlock', 'connect-account', 'account-platform', 'connect-github', 'copy-command', 'copy-config', 'copy-review-prompt', 'review-codex', 'review-claude', 'copy-requirement-prompt', 'import-cv', 'install-chatgpt', 'install-claude', 'open-extension-folder', 'career-list', 'career-read', 'career-open-profile', 'career-open-job', 'delete-rankings', 'open-exports', 'backup', 'approval', 'prescan-key-save', 'prescan-key-remove', 'prescan-range-set', 'prescan-preview', 'prescan-start', 'prescan-cancel', 'prescan-include', 'prescan-threshold', 'job-block', 'job-unblock', 'sharing-allow', 'sharing-stop', 'update-check', 'update-download', 'update-install', 'update-cancel']);
contextBridge.exposeInMainWorld('companion', Object.freeze({
  invoke(op, input = {}) {
    if (!allowed.has(op)) return Promise.reject(new Error('Unavailable local settings action.'));
    return ipcRenderer.invoke('local-settings', op, input);
  },
  onState(callback) {
    if (typeof callback !== 'function') return;
    const listener = () => callback();
    ipcRenderer.on('state-changed', listener);
    return () => ipcRenderer.removeListener('state-changed', listener);
  },
  onSettingsSection(callback) {
    if (typeof callback !== 'function') return;
    const listener = (_event, section) => { if (section === 'prescan') callback(section); };
    ipcRenderer.on('settings-section', listener);
    return () => ipcRenderer.removeListener('settings-section', listener);
  },
}));
