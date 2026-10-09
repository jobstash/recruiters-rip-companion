'use strict';
const { contextBridge, ipcRenderer } = require('electron');
const allowed = new Set(['state', 'unlock', 'pause', 'resume', 'unpair', 'install-native', 'connect-account', 'copy-command', 'copy-config', 'install-chatgpt', 'install-claude', 'open-exports', 'backup', 'approval']);
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
}));
