import { mkdir, writeFile, copyFile, cp, rm, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { version } from '../src/version.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export async function packageMcp() {
  const output = path.join(root, 'src', 'generated');
  await mkdir(output, { recursive: true });
  // Old generic artifacts must not remain installable beside Recruiters.rip.
  for (const name of ['recruiters-local.mcpb', 'recruiters.mcpb']) await rm(path.join(output, name), { force: true });
  const plugin = path.join(output, 'recruiters-rip-plugin');
  await rm(plugin, { recursive: true, force: true });
  await mkdir(path.join(plugin, 'skills'), { recursive: true });
  await cp(path.join(root, 'skills/recruiters-rip'), path.join(plugin, 'skills', 'recruiters-rip'), { recursive: true });
  await mkdir(path.join(plugin, '.codex-plugin'), { recursive: true });
  await writeFile(path.join(plugin, '.codex-plugin', 'plugin.json'), JSON.stringify({
    name: 'recruiters-rip', version,
    description: 'Recruiters.rip: complete saved rankings and grounded CareerCup CVs.',
    author: { name: 'JobStash' },
    skills: './skills/', mcpServers: './.mcp.json',
    interface: {
      displayName: 'Recruiters.rip', shortDescription: 'Read all evaluated jobs and prepare factual, reviewed CVs.',
      longDescription: 'Export the complete saved ranking, assess original job ads with your subscription app, and prepare evidence-grounded CareerCup CVs. Facts and drafts stay in the local companion.',
      developerName: 'JobStash', category: 'Productivity', capabilities: ['Read', 'Write'],
      defaultPrompt: ['Use Recruiters.rip. Show my current recommendations with salary, city/location, work mode and JobStash publication date. Keep the complete assessment archive and CSV available separately; do not present unreviewed or unsuitable archive rows as recommendations. Do not start new scoring unless I ask.'],
    },
  }, null, 2) + '\n');

}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await packageMcp();
