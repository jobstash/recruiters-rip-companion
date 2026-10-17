import { build } from 'esbuild';
import ts from 'typescript';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { packageMcp } from './package-mcp.mjs';
import cleanDist from './clean-dist.cjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const generated = path.join(root, 'src', 'generated');
await cleanDist();
await mkdir(path.join(generated, 'assets'), { recursive: true });
await build({
  entryPoints: [path.join(root, 'build', 'document-engine.cts')], outfile: path.join(generated, 'document-engine.cjs'),
  bundle: true, platform: 'node', format: 'cjs', target: 'node22', sourcemap: false,
  external: ['@nestjs/common', '@pdf-lib/fontkit', 'pdf-lib', 'pdf-parse', 'pdf-parse/*', 'mammoth', 'saxes', 'yauzl'],
  plugins: [{ name: 'existing-typescript-commonjs', setup(builder) {
    builder.onLoad({ filter: /\.[cm]?ts$/ }, async args => ({
      contents: ts.transpileModule(await readFile(args.path, 'utf8'), { compilerOptions: {
        target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: false, experimentalDecorators: true, emitDecoratorMetadata: false,
      }, fileName: args.path }).outputText,
      loader: 'js', resolveDir: path.dirname(args.path),
    }));
  } }],
});
for (const name of ['NotoSans-Regular.ttf', 'OFL.txt'])
  await copyFile(path.join(root, 'src', 'documents', 'assets', name), path.join(generated, 'assets', name));
await copyFile(path.join(root, 'src', 'mcp', 'local-runner.cjs'), path.join(generated, 'mcp-host.cjs'));
// Skill text is model-facing matching policy; its digest feeds the assessment policy fingerprint.
const skill = path.join(root, 'skills', 'recruiters-rip');
const skillDigest = createHash('sha256').update(await readFile(path.join(skill, 'SKILL.md'), 'utf8') + '\0' +
  await readFile(path.join(skill, 'agents', 'openai.yaml'), 'utf8')).digest('hex');
await writeFile(path.join(generated, 'skill-digest.mjs'), `export const SKILL_DIGEST = '${skillDigest}';\n`);
await packageMcp();
console.log('Built local MCP bridge, desktop extension packages and document engine with optional companion-managed pre-scanning.');
