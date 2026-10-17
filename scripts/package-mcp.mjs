import { mkdir, writeFile, copyFile, cp, rm, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { version } from '../src/version.mjs';
import cleanDist from './clean-dist.cjs';

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
    description: 'Find suitable jobs and prepare tailored CVs, cover letters and applications.',
    author: { name: 'JobStash' },
    skills: './skills/', mcpServers: './.mcp.json',
    interface: {
      displayName: 'Recruiters.rip', shortDescription: 'Find good jobs and prepare tailored applications.',
      longDescription: 'Match jobs to your career and preferences, create persuasive tailored CVs and cover letters, and complete authorized applications in your subscription app. Career data stays in the local companion.',
      developerName: 'JobStash', category: 'Productivity', capabilities: ['Read', 'Write'],
      defaultPrompt: ['Use Recruiters.rip. Show my current recommendations with salary, city/location, work mode and JobStash publication date. Keep the complete assessment archive and CSV available separately; do not present unreviewed or unsuitable archive rows as recommendations. Do not start new scoring unless I ask.'],
    },
  }, null, 2) + '\n');
  const staging = await mkdtemp(path.join(tmpdir(), 'recruiters-rip-mcp-package-'));
  try {
    await mkdir(path.join(staging, 'server'));
    await copyFile(path.join(root, 'src/mcp/local-runner.cjs'), path.join(staging, 'server', 'index.cjs'));
    await cp(path.join(root, 'skills/recruiters-rip'), path.join(staging, 'skills', 'recruiters-rip'), { recursive: true });
    for (const local of [false, true]) {
      const name = local ? 'recruiters-rip-local' : 'recruiters-rip';
      const manifest = {
        manifest_version: '0.3', name, display_name: 'Recruiters.rip', version,
        description: 'Complete saved rankings and grounded CareerCup CV preparation. Requires Recruiters.rip Companion.',
        long_description: 'Review jobs and prepare tailored application documents in your subscription app. Optional companion-managed API pre-scans prioritise jobs before final review and require a separately billed key entered only in local settings. The companion asks permission before sending career context to the provider. Keys are never exposed to chat. No web-job-search fallback.',
        author: { name: 'JobStash' },
        server: { type: 'node', entry_point: 'server/index.cjs', mcp_config: { command: 'node', args: ['${__dirname}/server/index.cjs', ...(local ? ['--local-product'] : [])] } },
        tools_generated: true, prompts_generated: true,
        compatibility: { platforms: ['darwin', 'linux'], runtimes: { node: '>=22.12.0' } },
      };
      await writeFile(path.join(staging, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
      const filename = path.join(output, `${name}.mcpb`);
      await rm(filename, { force: true });
      await new Promise((resolve, reject) => {
        const child = spawn('zip', ['-q', '-r', filename, 'manifest.json', 'server', 'skills'], { cwd: staging, stdio: ['ignore', 'ignore', 'inherit'] });
        child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(new Error('Recruiters.rip bundle packaging failed.')));
      });
    }
  } finally { await rm(staging, { recursive: true, force: true }); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await cleanDist();
  await packageMcp();
}
