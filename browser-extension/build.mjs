import { mkdir, copyFile, writeFile, readFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { BROWSER_IDENTITIES } from '../src/browser-identity.mjs';
import { createManifest } from './manifest.mjs';

const args = process.argv.slice(2), mode = args.find(arg => !arg.startsWith('--')) || 'production';
if (!['production', 'local'].includes(mode) || args.some(arg => !['production', 'local', '--zip'].includes(arg))) throw new Error('Use production or local, optionally --zip.');
const root = dirname(fileURLToPath(import.meta.url)), repo = dirname(root), out = join(root, 'dist', mode);
const { version } = JSON.parse(await readFile(join(repo, 'package.json'), 'utf8'));
const identity = BROWSER_IDENTITIES[mode];
const manifest = createManifest(identity, version, mode === 'local');
await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
for (const file of ['background.mjs','protocol.mjs','page-access.mjs','page.mjs','panel.html','panel.mjs','panel.css']) await copyFile(join(root, 'src', file), join(out, file));
await copyFile(join(repo, 'ui', 'design-tokens.css'), join(out, 'design-tokens.css'));
await mkdir(join(out, 'fonts'));
for (const file of ['InstrumentSerif-Regular.woff2','Geist-Regular.woff2','Geist-Medium.woff2','Geist-SemiBold.woff2','GeistMono-Regular.woff2','GeistMono-Medium.woff2','GeistMono-SemiBold.woff2','Geist-OFL.txt','InstrumentSerif-OFL.txt']) await copyFile(join(repo, 'ui', 'fonts', file), join(out, 'fonts', file));
await mkdir(join(out, 'brand'));
for (const file of ['recruiters-rip-lockup-reversed.svg','favicon-32.png']) await copyFile(join(repo, 'ui', 'brand', file), join(out, 'brand', file));
await writeFile(join(out, 'config.mjs'), `export const PRODUCT_ORIGIN = ${JSON.stringify(identity.productOrigin)};\nexport const NATIVE_HOST = ${JSON.stringify(identity.nativeHost)};\n`);
await writeFile(join(out, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
if (args.includes('--zip')) {
  const archive = join(root, 'dist', `recruiters-rip-browser-${mode}.zip`);
  await rm(archive, { force: true });
  execFileSync('zip', ['-q', '-r', archive, '.'], { cwd: out, stdio: 'inherit' });
  console.log(archive);
}
console.log(`Load unpacked: ${out}\nExtension ID: ${identity.extensionId}\nNative host: ${identity.nativeHost}`);
