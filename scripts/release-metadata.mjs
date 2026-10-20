import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readFile, readdir, realpath, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Works on both dist/release and dist/adhoc. This hashes existing artifacts only;
// it never builds, signs, notarizes, uploads, or invents release assets.
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const { version } = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(version)) throw new Error('Root package version must be a stable semantic version.');
if (process.argv.length !== 3) throw new Error('Usage: node scripts/release-metadata.mjs <output-directory>');
const directory = await realpath(path.resolve(process.argv[2]));
if (!(await lstat(directory)).isDirectory()) throw new Error('The artifact output directory does not exist.');
const names = ['zip', 'dmg'].map(extension => `recruiters-rip-companion-${version}-mac-arm64.${extension}`);
const present = new Set(await readdir(directory));
if (!present.has(names[0])) throw new Error(`Missing update ZIP: ${names[0]}`);
const lines = [];
for (const name of names) {
  if (!present.has(name)) continue;
  const artifact = path.join(directory, name);
  const info = await lstat(artifact);
  if (!info.isFile() || info.isSymbolicLink() || info.size === 0) throw new Error(`Artifact is not a non-empty regular file: ${name}`);
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(artifact)) hash.update(chunk);
  lines.push(`${hash.digest('hex')}  ${name}`);
}
const output = path.join(directory, 'SHA256SUMS.txt');
await writeFile(`${output}.tmp`, `${lines.join('\n')}\n`, { mode: 0o644 });
await rename(`${output}.tmp`, output);
console.log(`Wrote SHA256SUMS.txt for ${lines.length} existing macOS arm64 artifact${lines.length === 1 ? '' : 's'} at version ${version}.`);
