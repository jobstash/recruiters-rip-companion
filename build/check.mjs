import { readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
async function check(dir) {
 for (const entry of await readdir(dir, { withFileTypes: true })) {
  if (entry.name === 'generated' || entry.name === 'documents') continue;
  const file = `${dir}/${entry.name}`;
  if (entry.isDirectory()) await check(file);
  else if (/\.(mjs|cjs|js)$/.test(file)) { const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' }); if (result.status) process.exit(result.status); }
 }
}
for (const dir of ['bin','src','ui','build']) await check(dir);
