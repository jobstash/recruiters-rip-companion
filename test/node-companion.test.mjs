import test from 'node:test';
import http from 'node:http';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomBytes, createCipheriv, pbkdf2Sync } from 'node:crypto';
import { encryption, nodeVault } from '../src/node/storage.mjs';
import { createVault } from '../src/vault.mjs';
import { startService, validatePairing } from '../src/node/service.mjs';
import { mergeClaudeConfig } from '../src/node/hosts.mjs';
import { privateJSON, request } from '../src/node/launcher.mjs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
async function temp(t){const d=await mkdtemp(path.join(process.platform === 'win32' ? os.tmpdir() : '/tmp','rr-node-test-'));t.after(()=>rm(d,{recursive:true,force:true}));return d;}
function fakeKeys(){const passwords=new Map();return class{constructor(service,user){this.key=`${service}/${user}`;}getPassword(){return passwords.get(this.key);}setPassword(v){passwords.set(this.key,v);}};}
test('Node vault survives restart; ciphertext cannot be edited; missing keys never replace saved work',async t=>{
 const d=await temp(t),EntryClass=fakeKeys();const v=await nodeVault(d,{EntryClass});await v.update(s=>{s.label='Synthetic candidate';});const saved=await readFile(path.join(d,'vault.node.bin'));assert(!saved.includes('Synthetic candidate'));
 const reopened=await nodeVault(d,{EntryClass});assert.equal(reopened.get().label,'Synthetic candidate');assert.equal(v.get().deviceId,reopened.get().deviceId);
 await assert.rejects(nodeVault(d,{EntryClass:fakeKeys()}),/key.*missing/);assert.deepEqual(saved,await readFile(path.join(d,'vault.node.bin')));
 const altered=Buffer.from(saved);altered[altered.length-1]^=1;await writeFile(path.join(d,'vault.node.bin'),altered);await assert.rejects(nodeVault(d,{EntryClass}),/could not be opened/);assert.deepEqual(altered,await readFile(path.join(d,'vault.node.bin')));
});
test('synthetic macOS desktop vault carries identity and career history over without altering original',async t=>{
 const d=await temp(t),EntryClass=fakeKeys(),password='synthetic-keychain-secret';
 const original=createVault(encryption(randomBytes(32)),path.join(d,'original'));await original.open();await original.update(s=>{s.pairing={origin:'https://recruiters.rip',account:{id:'1',label:'Synthetic'}};s.career.facts.fixture={status:'active',text:'Synthetic fact'};});
 new EntryClass('Recruiters Companion Safe Storage','Recruiters Companion').setPassword(password);
 const cipher=createCipheriv('aes-128-cbc',pbkdf2Sync(password,'saltysalt',1003,16,'sha1'),Buffer.alloc(16,32));const bytes=Buffer.concat([Buffer.from('v10'),cipher.update(JSON.stringify(original.get()),'utf8'),cipher.final()]);await writeFile(path.join(d,'vault.bin'),bytes,{mode:0o600});
 const v=await nodeVault(d,{EntryClass,platform:'darwin'});assert.deepEqual(v.get(),original.get());assert.deepEqual(await readFile(path.join(d,'vault.bin')),bytes);
});
test('Claude installation merges other servers and settings and rejects malformed config',async t=>{
 const d=await temp(t),f=path.join(d,'claude.json');await writeFile(f,JSON.stringify({theme:'dark',mcpServers:{other:{command:'other'}}}));const transport={command:'/node',args:['/Recruiters Companion/bin/recruiters.mjs','mcp']};await mergeClaudeConfig(f,transport);await mergeClaudeConfig(f,transport);assert.deepEqual(JSON.parse(await readFile(f)),{theme:'dark',mcpServers:{other:{command:'other'},'recruiters-rip':transport}});
 await writeFile(f,'broken');await assert.rejects(mergeClaudeConfig(f,transport),/JSON/);assert.equal(await readFile(f,'utf8'),'broken');
});
test('pairing checks origin, current identity, expiry, account and challenge',()=>{
 const context={deviceId:'device',productOrigin:'https://recruiters.rip'},payload={productOrigin:context.productOrigin,pairing:{deviceId:'device',challenge:'a'.repeat(43),expiresAt:new Date(Date.now()+60000).toISOString(),account:{id:1,label:'Synthetic'}}};assert.equal(validatePairing(payload,context).account.id,1);
 for(const mutate of [p=>p.productOrigin='https://evil.test',p=>p.pairing.deviceId='wrong',p=>p.pairing.expiresAt='2020-01-01',p=>p.pairing.challenge='bad',p=>p.pairing.account.label='']){const p=structuredClone(payload);mutate(p);assert.throws(()=>validatePairing(p,context));}
 assert.throws(()=>validatePairing(payload,{...context,existing:{origin:context.productOrigin,account:{id:'different'}}}),/another account/);
});
test('real Node service and stdio MCP: connection, pause, lock, browser isolation, saved data and restart',async t=>{
 const base=await temp(t),directory=path.join(base,'device'),paths={base,directory,control:path.join(directory,'node-control.json'),lock:path.join(directory,'node.lock'),localOnly:true};
 const key=randomBytes(32),factory=async d=>{const v=createVault(encryption(key),d,{filename:'vault.node.bin'});await v.open();return v;};
 const service=await startService(paths,{vaultFactory:factory,open:async()=>{},monitor:()=>()=>{},isScreenLocked:async()=>false});t.after(()=>service.close());
 const config=await privateJSON(paths.control),headers={'content-type':'application/json',authorization:`Bearer ${config.token}`};
 assert.equal((await fetch(`${config.origin}/action`,{method:'POST',headers:{'content-type':'application/json'},body:'{"op":"state"}'})).status,401);
 assert.equal((await fetch(`${config.origin}/action`,{method:'POST',headers:{...headers,origin:'https://evil.test'},body:'{"op":"state"}'})).status,403);
 assert.equal(await new Promise((resolve,reject)=>{const r=http.request(`${config.origin}/action`,{method:'POST',headers:{...headers,host:'evil.test'}},res=>{res.resume();resolve(res.statusCode);});r.on('error',reject);r.end('{"op":"state"}');}),403);
 assert.equal((await fetch(`${config.origin}/pair`,{method:'POST',headers,body:JSON.stringify({state:'wrong',payload:{}})})).status,403);
 await assert.rejects(startService(paths,{vaultFactory:factory,open:async()=>{},monitor:()=>()=>{},isScreenLocked:async()=>false}),/already running/);
 // Use an actual stdio client through the Node proxy without reading any user vault.
 const fixture=path.join(base,'mcp.mjs');await writeFile(fixture,`import {proxyMcp} from ${JSON.stringify(new URL('../src/node/launcher.mjs',import.meta.url).href)};await proxyMcp(${JSON.stringify(paths)});`);
 const transport=new StdioClientTransport({command:process.execPath,args:[fixture],stderr:'pipe'}),client=new Client({name:'synthetic-test',version:'1'},{capabilities:{}});await client.connect(transport);t.after(()=>client.close());
 const tools=await client.listTools();assert(tools.tools.some(x=>x.name==='career_profile_read'));assert(tools.tools.some(x=>x.name==='career_application_export'));
 const result=await client.callTool({name:'career_profile_read',arguments:{}});assert(!result.isError);
 await request(paths,'pause');const paused=await client.callTool({name:'account_connect',arguments:{}});assert(paused.isError);assert.match(paused.content[0].text,/LOCAL_PAUSED/);
 await request(paths,'resume');assert.equal((await request(paths,'state')).paused,false);
 await request(paths,'lock');assert.equal((await request(paths,'state')).locked,true);await client.close();
 await request(paths,'unlock');await service.close();const again=await startService(paths,{vaultFactory:factory,open:async()=>{},monitor:()=>()=>{},isScreenLocked:async()=>false});t.after(()=>again.close());assert.equal(again.status().locked,false);await again.close();
});
