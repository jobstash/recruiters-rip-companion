#!/usr/bin/env node
import { paths, root } from '../src/node/paths.mjs';
import { version } from '../src/version.mjs';
import { openBrowser } from '../src/node/system.mjs';
import { request, ensureService, persistRuntime, proxyMcp } from '../src/node/launcher.mjs';
import { writeFile, unlink } from 'node:fs/promises';
import path from 'node:path';
const args=process.argv.slice(2),localOnly=args.includes('--local-product');
const positional=args.filter(a=>a!=='--local-product'),command=positional[0]??'setup';
const help=`Recruiters.rip ${version}\n\nrecruiters              Set up and open your companion\nrecruiters open         Open your controls\nrecruiters status       Show connection status\nrecruiters start        Start local tools in the background\nrecruiters stop         Stop local tools\nrecruiters pause        Pause local changes\nrecruiters resume       Resume local changes\nrecruiters lock         Lock local tools\nrecruiters mcp          Connect an AI app (standard input/output)\n\nRun the same npx Git command with any of these actions. Node.js 22.12+ is required.\n`;
async function main(){
  const [major,minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 12)) throw new Error('Install Node.js 22.12 or newer from nodejs.org, then run this command again.');
  if(['--help','help','-h'].includes(command)){process.stdout.write(help);return;}
  if(['--version','-v'].includes(command)){console.log(version);return;}
  if(positional.length>1||!['setup','open','start','stop','status','pause','resume','lock','mcp','serve'].includes(command))throw new Error('Unknown command. Run recruiters --help.');
  const p=paths({localOnly});
  if(command==='serve'){
    const {startService}=await import('../src/node/service.mjs');
    try{const service=await startService(p);await unlink(path.join(p.directory,'startup-error.json')).catch(()=>{});for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>void service.close());}
    catch(e){await writeFile(path.join(p.directory,'startup-error.json'),JSON.stringify({at:Date.now(),message:e.message}),{mode:0o600}).catch(()=>{});throw e;}return;
  }
  if(command==='mcp'){await proxyMcp(p);return;}
  if(['status','stop','pause','resume','lock'].includes(command)){
    let result;try{result=await request(p,command==='status'?'state':command);}catch(e){if(command==='status'||command==='stop'){console.log('Companion is stopped. Run recruiters to open it.');return;}throw e;}
    console.log(command==='status'?`Companion ${result.version}: ${result.locked?'locked':result.paused?'paused':'running'}\nAccount: ${result.paired?'connected':'not connected'}\nAI connections: ${result.mcpConnections}${result.failure?`\n${result.failure}`:''}`:`Companion ${command==='stop'?'stopped':command==='pause'?'paused':command==='resume'?'resumed':'locked'}.`);return;
  }
  console.log('Preparing Recruiters.rip…');
  const installed=await persistRuntime(p);const data=await ensureService(p,installed);
  if(command!=='start'){
    const url=`${data.origin}/#token=${data.token}`;
    try{await openBrowser(url);console.log('Your companion controls are open in the browser. You can close this terminal.');}catch{console.log(`Open this private address on this computer:\n${url}`);}
  }else console.log('Companion is running. Run recruiters open for controls.');
}
main().catch(error=>{process.stderr.write(`Recruiters.rip: ${error.message}\n`);process.exitCode=1;});
