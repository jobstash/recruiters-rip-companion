// One main process, two shells. Started by Electron, Companion is the desktop app with a native
// window. Started by plain Node (`node src/main.mjs`, as in the container), the same code runs
// against stand-ins that serve the same screens to a browser. Features that cannot behave the
// same way in both read `webShell`.
export const webShell = !process.versions.electron;
const api = await import(webShell ? './web-shell.mjs' : 'electron');
export const { app, BrowserWindow, ipcMain, powerMonitor, Menu, shell, clipboard, dialog, safeStorage } = api;
/** The web shell's HTTP host: its origin, container name and extra routes. `null` in Electron. */
export const webHost = webShell ? api.webHost : null;
