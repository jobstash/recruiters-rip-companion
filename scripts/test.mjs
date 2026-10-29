import { readdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const tests = (await readdir(path.join(root, 'test'))).filter(name => name.endsWith('.test.mjs')).sort();
const child = spawn(process.execPath, ['--test', ...tests.map(name => path.join(root, 'test', name))], { cwd: root, stdio: 'inherit' });
child.once('error', error => { console.error(error.message); process.exitCode = 1; });
child.once('exit', (code, signal) => { process.exitCode = signal ? 1 : code ?? 1; });
