'use strict';
const { contextBridge, ipcRenderer } = require('electron');
const allowed = new Set(['state', 'unlock', 'connect-account', 'account-platform', 'connect-github', 'get-codex', 'get-claude', 'copy-command', 'copy-config', 'copy-review-prompt', 'review-codex', 'review-claude', 'copy-requirement-prompt', 'import-cv', 'install-chatgpt', 'install-claude', 'save-extension', 'save-firefox-extension', 'career-list', 'career-read', 'career-open-profile', 'career-open-job', 'career-open-document', 'delete-rankings', 'backup', 'approval', 'decisions-key-save', 'decisions-key-remove', 'publication-range-set', 'job-block', 'job-unblock', 'sharing-allow', 'sharing-stop', 'update-check', 'update-download', 'update-install', 'update-cancel']);
for (const operation of ['backup-preview', 'backup-restore', 'backup-cancel', 'backup-open-folder', 'cv-delete']) allowed.add(operation);
allowed.add('update-preferences');
allowed.add('update-source-guide');
contextBridge.exposeInMainWorld('companion', Object.freeze({
  invoke(op, input = {}) {
    if (!allowed.has(op)) return Promise.reject(new Error('Unavailable local settings action.'));
    if (op === 'update-preferences' && (!input || typeof input !== 'object' || Array.isArray(input) ||
        Object.keys(input).length !== 1 || !Object.hasOwn(input, 'automaticUpdates') || typeof input.automaticUpdates !== 'boolean'))
      return Promise.reject(new Error('Choose whether to keep the app up to date.'));
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
    const listener = (_event, section) => { if (section === 'decisions') callback(section); };
    ipcRenderer.on('settings-section', listener);
    return () => ipcRenderer.removeListener('settings-section', listener);
  },
}));
