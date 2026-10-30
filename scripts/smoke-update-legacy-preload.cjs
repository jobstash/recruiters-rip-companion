'use strict';
// CI instrumentation only. The published 3.10 controller/helper stay byte-for-
// byte unchanged. Only their exact LaunchServices invocation receives the
// isolated profile/environment arguments missing from that historical helper.
const fs = require('node:fs');
const path = require('node:path');
const childProcess = require('node:child_process');
if (process.platform !== 'darwin' || process.env.GITHUB_ACTIONS !== 'true' || process.env.RUNNER_ENVIRONMENT !== 'github-hosted') throw new Error('Legacy launch isolation requires a disposable GitHub-hosted Mac runner.');
const configFile = process.env.RECRUITERS_UPDATE_SMOKE_CONFIG;
if (!configFile || !path.isAbsolute(configFile)) throw new Error('Missing isolated legacy smoke configuration.');
const info = fs.lstatSync(configFile);
if (!info.isFile() || info.isSymbolicLink() || info.size > 16384 || info.uid !== process.getuid() || (info.mode & 0o077)) throw new Error('Unsafe legacy smoke configuration.');
const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
const scratch = path.dirname(configFile);
for (const value of [config.target, config.userData, config.audit]) if (typeof value !== 'string' || !value.startsWith(`${scratch}${path.sep}`) || path.resolve(value) !== value) throw new Error('Legacy smoke path escaped its temporary directory.');
const allowed = new Set(['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_RUNTIME_DIR', 'TMPDIR', 'TMP', 'TEMP']);
for (const [key, value] of Object.entries(config.environment)) if (!allowed.has(key) || typeof value !== 'string' || !value.startsWith(`${scratch}${path.sep}`) || /[\r\n\0]/.test(value)) throw new Error('Legacy smoke environment escaped its temporary directory.');
const spawn = childProcess.spawn;
childProcess.spawn = function (command, args, options) {
  if (command !== '/usr/bin/open') return spawn.call(this, command, args, options);
  if (!Array.isArray(args) || args.length !== 2 || args[0] !== '-n' || args[1] !== config.target) throw new Error('Unexpected legacy LaunchServices invocation; refusing an unisolated launch.');
  const isolated = [...args, ...Object.entries(config.environment).flatMap(([key, value]) => ['--env', `${key}=${value}`]), '--args', `--user-data-dir=${config.userData}`];
  fs.appendFileSync(config.audit, JSON.stringify({ command, originalArgs: args, isolatedArgs: isolated }) + '\n', { mode: 0o600 });
  return spawn.call(this, command, isolated, options);
};
