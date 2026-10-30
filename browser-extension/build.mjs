import { mkdir, copyFile, writeFile, readFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import AdmZip from 'adm-zip';
import { createHash } from 'node:crypto';
import { BROWSER_IDENTITIES } from '../src/browser-identity.mjs';
import { createManifest } from './manifest.mjs';

const args = process.argv.slice(2), mode = args.find(arg => !arg.startsWith('--')) || 'production';
const browser = args.find(arg => arg.startsWith('--browser='))?.slice('--browser='.length) || 'chrome';
if (!['production', 'local'].includes(mode) || !['chrome', 'firefox'].includes(browser) ||
    args.some(arg => !['production', 'local', '--zip', '--browser=chrome', '--browser=firefox'].includes(arg)) ||
    args.filter(arg => !arg.startsWith('--')).length > 1 || args.filter(arg => arg.startsWith('--browser=')).length > 1)
  throw new Error('Use production|local --browser=chrome|firefox [--zip].');
const root = dirname(fileURLToPath(import.meta.url)), repo = dirname(root), target = browser === 'firefox' ? `firefox-${mode}` : mode, out = join(root, 'dist', target);
const { version } = JSON.parse(await readFile(join(repo, 'package.json'), 'utf8'));
const identity = BROWSER_IDENTITIES[mode];
const manifest = createManifest(identity, version, mode === 'local', browser);
await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
const sources = ['background.mjs','protocol.mjs','page-access.mjs','page.mjs','panel.html','panel.mjs','panel-flow.mjs','panel.css'];
const buildHash = createHash('sha256').update(JSON.stringify(manifest));
for (const file of sources) {
  const source = await readFile(join(root, 'src', file));
  buildHash.update(file).update(source);
  await writeFile(join(out, file), source);
}
await copyFile(join(repo, 'ui', 'design-tokens.css'), join(out, 'design-tokens.css'));
await mkdir(join(out, 'fonts'));
for (const file of ['InstrumentSerif-Regular.woff2','Geist-Regular.woff2','Geist-Medium.woff2','Geist-SemiBold.woff2','GeistMono-Regular.woff2','GeistMono-Medium.woff2','GeistMono-SemiBold.woff2','Geist-OFL.txt','InstrumentSerif-OFL.txt']) await copyFile(join(repo, 'ui', 'fonts', file), join(out, 'fonts', file));
await mkdir(join(out, 'brand'));
for (const file of ['recruiters-rip-lockup-reversed.svg','favicon-32.png']) await copyFile(join(repo, 'ui', 'brand', file), join(out, 'brand', file));
await writeFile(join(out, 'config.mjs'), `export const PRODUCT_ORIGIN = ${JSON.stringify(identity.productOrigin)};\nexport const NATIVE_HOST = ${JSON.stringify(identity.nativeHost)};\nexport const BUILD_ID = ${JSON.stringify(buildHash.digest('hex').slice(0, 16))};\n`);
await writeFile(join(out, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
if (args.includes('--zip')) {
  const archive = join(root, 'dist', `recruiters-rip-browser-${target}.zip`);
  const zip = new AdmZip();
  zip.addLocalFolder(out);
  zip.writeZip(archive);
  console.log(archive);
}
console.log(`${browser === 'firefox' ? 'Load temporarily via about:debugging (distribution requires AMO-signed XPI)' : 'Load unpacked'}: ${out}\nExtension ID: ${browser === 'firefox' ? identity.firefoxExtensionId : identity.extensionId}\nNative host: ${identity.nativeHost}`);
