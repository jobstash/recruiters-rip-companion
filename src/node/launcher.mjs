import { cp, mkdir, readFile, writeFile, lstat, rename, rm, access } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { root, cleanEnvironment, mcpSocket } from './paths.mjs';
import { version } from '../version.mjs';
import { privateDirectory } from '../vault.mjs';
import { npm } from './system.mjs';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
export async function privateJSON(filename) {
  const info=await lstat(filename);
  if(!info.isFile()||info.isSymbolicLink()||info.size>16384||(process.getuid&&info.uid!==process.getuid())||(process.platform!=='win32'&&(info.mode&0o077)))throw new Error('The local connection settings are not private.');
  return JSON.parse(await readFile(filename,'utf8'));
}
export async function request(paths,op,input={}) {
  const data=await privateJSON(paths.control),url=new URL(data.origin);
  if(url.protocol!=='http:'||url.hostname!=='127.0.0.1'||url.pathname!=='/'||url.username||url.password||!/^\d+$/.test(url.port)||!/^[a-f0-9]{64}$/.test(data.token))throw new Error('Invalid companion connection.');
  const response=await fetch(`${data.origin}/action`,{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${data.token}`},body:JSON.stringify({op,input}),signal:AbortSignal.timeout(5000),redirect:'error'});
  const result=await response.json();if(!response.ok||!result.ok)throw new Error(result.error?.message??'The local companion is unavailable.');return result.result;
}
export async function persistRuntime(paths) {
  const target=path.join(paths.runtime,version);
  if(root===target)return target;
  await privateDirectory(paths.runtime);
  try { await access(path.join(target,'ready'));return target; }catch{}
  const staging=path.join(paths.runtime,`${version}-${process.pid}.tmp`);
  await privateDirectory(staging);
  try {
    for(const name of ['bin','src','ui','skills','package.json','npm-shrinkwrap.json'])await cp(path.join(root,name),path.join(staging,name),{recursive:true});
    await npm(['ci','--omit=dev','--ignore-scripts','--no-audit','--no-fund'],{cwd:staging,stdio:['ignore','ignore','pipe']});
    await writeFile(path.join(staging,'ready'),version,{mode:0o600});
    try{await rename(staging,target);}catch(e){if(!['EEXIST','ENOTEMPTY'].includes(e.code))throw e;await access(path.join(target,'ready'));}
    return target;
  }finally{await rm(staging,{recursive:true,force:true});}
}
export async function ensureService(paths, runtimeRoot=root) {
  try { await request(paths,'state');return privateJSON(paths.control); }catch{}
  await privateDirectory(paths.directory);
  await rm(path.join(paths.directory,'startup-error.json'),{force:true});
  const child=spawn(process.execPath,[path.join(runtimeRoot,'bin/recruiters.mjs'),'serve',...(paths.localOnly?['--local-product']:[])],{detached:true,stdio:'ignore',env:cleanEnvironment()});
  child.on('error',()=>{});child.unref();
  for(let i=0;i<120;i++){
    await sleep(250);
    try {await request(paths,'state');return privateJSON(paths.control);}catch{}
    try {const failure=await privateJSON(path.join(paths.directory,'startup-error.json'));if(failure.at>=Date.now()-35000)throw new Error(failure.message);}catch(e){if(e.code!=='ENOENT'&&e.message!=='The local connection settings are not private.')throw e;}
  }
  throw new Error('The companion could not start. Quit the desktop companion if it is open, then run the setup command again.');
}
export async function proxyMcp(paths) {
  await ensureService(paths);
  const config=await privateJSON(path.join(paths.directory,'mcp-bridge.json'));
  if(config.socket!==mcpSocket(paths.directory)||!/^[a-f0-9]{64}$/.test(config.token))throw new Error('Invalid local MCP settings.');
  const socket=await new Promise((resolve,reject)=>{const s=net.connect(config.socket);s.once('error',reject);s.once('connect',()=>{s.removeListener('error',reject);s.write(JSON.stringify({auth:config.token})+'\n');resolve(s);});});
  socket.on('error',()=>{process.stderr.write('The local companion disconnected. Run recruiters status for details.\n');process.exitCode=1;process.stdin.destroy();});
  socket.on('close',()=>process.stdin.destroy());process.stdin.pipe(socket);socket.pipe(process.stdout);process.stdin.on('end',()=>socket.end());
  for(const signal of ['SIGTERM','SIGINT'])process.once(signal,()=>{socket.destroy();process.exit(0);});
}
