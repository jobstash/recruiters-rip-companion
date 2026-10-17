// `pnpm dev`: run the companion from source with live reload.
// ui/ changes reload the settings window in place (handled in src/main.mjs);
// src/ and scripts/ changes restart Electron, rebuilding the generated runtime first when its inputs changed.
import { spawn } from 'node:child_process';
import { watch } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const electron = createRequire(import.meta.url)('electron');
const args = ['.', ...process.argv.slice(2)];
let child, restarting = false, pending, rebuild = false, stopping = false;

const runtimeBuild = () => new Promise((resolve, reject) => {
  const build = spawn(process.execPath, [path.join(root, 'scripts', 'runtime.mjs')], { cwd: root, stdio: 'inherit' });
  build.on('exit', code => code === 0 ? resolve() : reject(new Error(`Runtime build exited with ${code}`)));
});

function start() {
  child = spawn(electron, args, { cwd: root, stdio: 'inherit', env: { ...process.env, RECRUITERS_COMPANION_DEV: '1' } });
  child.on('exit', code => {
    child = undefined;
    if (!restarting && !stopping) { console.log(`Companion exited (${code ?? 'signal'}). Save a source file to start it again.`); }
  });
}

async function restart() {
  restarting = true;
  if (child) await new Promise(resolve => { child.once('exit', resolve); child.kill('SIGTERM'); });
  try {
    if (rebuild) { rebuild = false; await runtimeBuild(); }
    start();
  } catch (error) { console.error(error.message); }
  restarting = false;
}

const generated = path.join('src', 'generated');
const queue = (needsBuild) => {
  rebuild ||= needsBuild;
  clearTimeout(pending);
  pending = setTimeout(() => { console.log('Source changed; restarting the companion.'); void restart(); }, 200);
};
watch(path.join(root, 'src'), { recursive: true }, (_event, file) => {
  if (!file) return;
  const relative = path.join('src', file);
  if (relative.startsWith(generated)) return;
  queue(relative.startsWith(path.join('src', 'documents')) || relative === path.join('src', 'mcp', 'local-runner.cjs'));
});
watch(path.join(root, 'scripts'), { recursive: true }, (_event, file) => { if (file && file !== 'dev.mjs') queue(true); });
watch(path.join(root, 'skills'), { recursive: true }, (_event, file) => { if (file) queue(true); });

for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { stopping = true; clearTimeout(pending); child?.kill('SIGTERM'); process.exit(0); });

await runtimeBuild();
start();
