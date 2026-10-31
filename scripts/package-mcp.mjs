import { mkdir, writeFile, cp, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { version } from '../src/version.mjs';
import cleanDist from './clean-dist.cjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export async function packageMcp() {
  const output = path.join(root, 'src', 'generated');
  await mkdir(output, { recursive: true });
  // Old Claude extension bundles must not remain installable: Claude is set up through its own config file.
  for (const name of ['recruiters-local.mcpb', 'recruiters.mcpb', 'recruiters-rip-local.mcpb', 'recruiters-rip.mcpb']) await rm(path.join(output, name), { force: true });
  const plugin = path.join(output, 'recruiters-rip-plugin');
  await rm(plugin, { recursive: true, force: true });
  await mkdir(path.join(plugin, 'skills'), { recursive: true });
  await cp(path.join(root, 'skills/recruiters-rip'), path.join(plugin, 'skills', 'recruiters-rip'), { recursive: true });
  await mkdir(path.join(plugin, '.codex-plugin'), { recursive: true });
  await writeFile(path.join(plugin, '.codex-plugin', 'plugin.json'), JSON.stringify({
    name: 'recruiters-rip', version,
    description: 'Find suitable jobs and prepare tailored CVs, cover letters and applications.',
    author: { name: 'JobStash' },
    skills: './skills/', mcpServers: './.mcp.json',
    interface: {
      displayName: 'Recruiters.rip', shortDescription: 'Find good jobs and prepare tailored applications.',
      longDescription: 'Match jobs to your career and preferences and prepare tailored CVs, cover letters and answers. Apply in your own supported browser when your subscription app provides computer-use tools, using its mouse, keyboard and file picker. Companion does not provide browser input; documents and prepared answers remain usable without it. Career data stays in the local companion.',
      developerName: 'JobStash', category: 'Productivity', capabilities: ['Read', 'Write'],
      defaultPrompt: ['Use Recruiters.rip. Show my current recommendations with salary, city/location, work mode and JobStash publication date. Keep the complete assessment archive and CSV available separately; do not present unreviewed or unsuitable archive rows as recommendations. Do not start new scoring unless I ask.'],
    },
  }, null, 2) + '\n');
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await cleanDist();
  await packageMcp();
}
