import { readFile, writeFile, mkdir, rm, lstat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { randomUUID, randomBytes, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import net from 'node:net';
import { nodeVault } from './storage.mjs';
import { privateDirectory } from '../vault.mjs';
import { createDeviceClient } from '../client.mjs';
import { createMcpServer, createPlatformTools } from '../mcp/server.mjs';
import { createProfileTools } from '../mcp/profile-tools.mjs';
import { createApplicationTools } from '../mcp/application-tools.mjs';
import { createMatchingTools } from '../mcp/matching-tools.mjs';
import { createScopedAccess } from '../mcp/scope.mjs';
import { createDocumentFiles } from '../mcp/files.mjs';
import { startMcpBroker } from '../mcp/broker.mjs';
import { fail } from '../mcp/state.mjs';
import { root, cleanEnvironment } from './paths.mjs';
import { openBrowser, exec } from './system.mjs';
import { installHost, codexStatus, findCodex } from './hosts.mjs';
import { controlServer } from './control.mjs';
import { watchScreenLock, screenLocked } from './screen-lock.mjs';
import { version } from '../version.mjs';

export async function acquireLock(paths) {
  await privateDirectory(paths.directory);
  // Never run beside the Electron app: both would write the same career identity.
  if (process.platform !== 'win32') for (const name of ['native.sock', 'mcp.sock']) {
    const live = await new Promise(resolve => { const socket = net.connect(path.join(paths.directory, name)); socket.setTimeout(300); socket.once('connect',()=>{socket.destroy();resolve(true);}); socket.once('error',()=>resolve(false)); socket.once('timeout',()=>{socket.destroy();resolve(false);}); });
    if (live) throw new Error('The companion is already running. Quit the desktop companion before starting the Node version.');
  }
  try { await mkdir(paths.lock, { mode: 0o700 }); }
  catch (e) {
    if (e.code !== 'EEXIST') throw e;
    let pid;
    try { pid = JSON.parse(await readFile(path.join(paths.lock,'owner.json'),'utf8')).pid; }
    catch { throw new Error('A companion startup is in progress. Wait a moment before starting again.'); }
    if (!Number.isInteger(pid) || pid < 1) throw new Error('The companion lock is invalid. Saved data was not opened.');
    try { process.kill(pid, 0); throw new Error('The companion is already running. Use recruiters open.'); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
    await rm(paths.lock, { recursive: true }); await mkdir(paths.lock, { mode: 0o700 });
  }
  await writeFile(path.join(paths.lock,'owner.json'), JSON.stringify({pid:process.pid}), {mode:0o600});
  return () => rm(paths.lock,{recursive:true,force:true});
}
export function validatePairing(payload, { productOrigin, deviceId, existing, now = Date.now() }) {
  if (!payload || Object.keys(payload).some(k=>!['productOrigin','pairing'].includes(k))) throw new Error('Invalid account connection.');
  const p = payload.pairing, expiry = Date.parse(p?.expiresAt);
  if (!p || Object.keys(p).some(k=>!['deviceId','challenge','expiresAt','account'].includes(k)) || payload.productOrigin !== productOrigin || p.deviceId !== deviceId || !Number.isFinite(expiry) || expiry <= now || expiry > now+301000 || !/^[A-Za-z0-9_-]{43}$/.test(p.challenge) || !p.account || Object.keys(p.account).some(k=>!['id','label'].includes(k)) || !['string','number'].includes(typeof p.account.id) || !String(p.account.id).length || String(p.account.id).length > 200 || typeof p.account.label !== 'string' || !p.account.label.length || p.account.label.length > 240) throw new Error('This account connection is invalid or expired. Open Connect account again.');
  if (existing && (String(existing.account.id) !== String(p.account.id) || existing.origin !== payload.productOrigin)) throw new Error('This computer is connected to another account. Disconnect it in local settings before switching.');
  return p;
}
export async function startService(paths, { vaultFactory = nodeVault, open = openBrowser, documents: injectedDocuments, monitor = watchScreenLock, isScreenLocked = screenLocked } = {}) {
  const release = await acquireLock(paths);
  let vault, bridge, control, heartbeat, approval, sourceRequest, hostState = null, failure = '', closed = false, sessionEpoch = 0, mcpConnections = 0, lastTool = null, locked = true, pauseRequested = false;
  let openingVault, stopScreenMonitor, pairState, approvalQueue = Promise.resolve(), heartbeatBusy = false, hostBusy = false;
  const productOrigin = paths.localOnly ? 'http://127.0.0.1:3001' : 'https://recruiters.rip';
  const documents = injectedDocuments ?? createRequire(import.meta.url)('../generated/document-engine.cjs');
  function assertAvailable(mutation) { if (locked || !vault) fail('LOCAL_LOCKED','Open the companion controls and unlock local storage.'); if (mutation && (pauseRequested || vault.get().userPaused)) fail('LOCAL_PAUSED','Local changes are paused. Resume them in the companion controls.'); }
  const store = { get(){assertAvailable(false);return vault.get();}, update(change){assertAvailable(false);return vault.update(async s=>{assertAvailable(false);await change(s);assertAvailable(false);});} };
  const client = createDeviceClient(store, paths.localOnly);
  const files = createDocumentFiles({directory:paths.directory,store,assertAvailable});
  async function initialize(explicit = false) {
    if (await isScreenLocked()) throw new Error('Unlock this computer before opening local storage.');
    if (!vault) {
      openingVault ??= vaultFactory(paths.directory);
      try { vault = await openingVault; } finally { openingVault = null; }
    }
    if (explicit) await vault.update(s => { s.userLocked = false; });
    locked = vault.get().userLocked === true;
    failure = '';
  }
  async function showSettings() { await open(control.url); }
  function requestApproval(title, detail) {
    const pending = approvalQueue.then(()=>new Promise(resolve=>{
      const timer=setTimeout(()=>approval?.finish(false),120000);
      approval={ id:randomUUID(), title, detail, finish(allow){clearTimeout(timer);approval=null;resolve(allow === true && !locked);} };
      void showSettings().catch(()=>{});
    })); approvalQueue=pending.catch(()=>false);return pending;
  }
  async function connectAccount() {
    assertAvailable(false); const state=store.get(), url=new URL('/settings/provider', productOrigin);
    pairState={value:randomBytes(32).toString('base64url'),expiresAt:Date.now()+15*60000};
    url.search=new URLSearchParams({deviceId:state.deviceId,publicKey:state.publicKey,deviceLabel:state.label,companionReturn:`${control.origin}/pair`,companionState:pairState.value}).toString();
    await open(url.href);
  }
  async function pair(payload) {
    try {
      assertAvailable(false); const before=store.get(), p=validatePairing(payload,{productOrigin,deviceId:before.deviceId,existing:before.pairing});
      if (!await requestApproval('Connect this account?', `${p.account.label}\n\nWebsite: ${productOrigin}\n\nThis account can request fresh jobs through your membership. Your CVs, facts, matches and drafts stay on this computer.`)) return;
      validatePairing(payload,{productOrigin,deviceId:store.get().deviceId,existing:store.get().pairing});
      const activation=await client.request('POST','/device/activate',{challenge:p.challenge,account:p.account},{origin:productOrigin});
      if (activation.deviceId!==p.deviceId || String(activation.account?.id)!==String(p.account.id) || activation.account?.label!==p.account.label) throw new Error('The account approval did not match the activated device.');
      await store.update(s=>{if(s.deviceId!==p.deviceId)throw new Error('The local identity changed.');s.pairing={origin:productOrigin,account:{...p.account}};});
      failure='';
    } catch(e){failure=e.message;throw e;}
  }
  async function platform(operation,args){ assertAvailable(false);if(!store.get().pairing)fail('PAIRING_REQUIRED','Choose Connect account in the companion controls.');return client.request('POST','/device/platform',{operation,args}); }
  async function selectSourceFile(){
    assertAvailable(true);if(sourceRequest)fail('LOCAL_BUSY','Choose or cancel the CV already requested in the companion controls.');
    return new Promise(resolve=>{const timer=setTimeout(()=>sourceRequest?.finish(null),120000);sourceRequest={id:randomUUID(),finish(value){clearTimeout(timer);sourceRequest=null;resolve(value);}};void showSettings().catch(()=>{});});
  }
  function createSessionServer(){
    const scoped=createScopedAccess(store,{assertAvailable,epoch:()=>sessionEpoch});
    const localFiles=createDocumentFiles({directory:paths.directory,store:scoped.store,assertAvailable:scoped.assertAvailable});
    const scopedPlatform=async(op,args)=>{scoped.assertAvailable(false);const result=await platform(op,args);scoped.assertAvailable(false);return result;};
    const tools=[...createPlatformTools({store:scoped.store,platform:scopedPlatform,connectAccount,openSettings:showSettings}),...createProfileTools({store:scoped.store,selectSourceFile:async()=>{scoped.assertAvailable(true);const result=await selectSourceFile();scoped.assertAvailable(true);return result;},extractFile:documents.extractFile}),...createApplicationTools({store:scoped.store,platform:scopedPlatform,documents,exportDocument:localFiles.exportDocument}),...createMatchingTools({store:scoped.store,platform:scopedPlatform,exportDocument:localFiles.exportDocument})];
    return createMcpServer({tools,assertAvailable:scoped.assertAvailable,readResource:localFiles.readResource,listResources:localFiles.listResources,notifyActivity:name=>{lastTool={name,at:new Date().toISOString()};}});
  }
  const status=()=>({version,running:!closed,locked,failure,paused:!locked&&store.get().userPaused,paired:!locked&&Boolean(store.get().pairing),account:!locked?store.get().pairing?.account:null,mcpConnections,lastTool,approval:approval?{id:approval.id,title:approval.title,detail:approval.detail}:null,sourceRequest:sourceRequest?{id:sourceRequest.id}:null,host:hostState?{kind:hostState.kind,installed:hostState.installed,auth:hostState.auth,message:hostState.message}:null,hostBusy});
  async function close(){if(closed)return;closed=true;clearInterval(heartbeat);stopScreenMonitor?.();approval?.finish(false);sourceRequest?.finish(null);await bridge?.close();await control?.close();await release();}
  async function invoke(op,input={}){
    if(op==='state')return status();
    if(op==='stop'){setTimeout(()=>void close(),100);return {stopped:true};}
    if(op==='unlock'){await initialize(true);return status();}
    assertAvailable(false);
    if(op==='pause'||op==='resume'){pauseRequested=op==='pause';await store.update(s=>{s.userPaused=pauseRequested;});if(pauseRequested){approval?.finish(false);sourceRequest?.finish(null);}return status();}
    if(op==='lock'){await vault.update(s=>{s.userLocked=true;});sessionEpoch++;locked=true;approval?.finish(false);sourceRequest?.finish(null);bridge.disconnect();return status();}
    if(op==='approval'){if(!approval||input.id!==approval.id||typeof input.allow!=='boolean')throw new Error('This approval expired.');approval.finish(input.allow);return {completed:true};}
    if(op==='connect-account'){await connectAccount();return {opened:true};}
    if(op==='install-host'){
      if(hostBusy)throw new Error('AI app setup is already running.');hostBusy=true;
      hostState={kind:input.kind,installed:false,message:'Installing your AI connection…'};
      void installHost(input.kind,paths,{notify:message=>{hostState.message=message;}}).then(result=>{hostState=result;failure='';return writeFile(path.join(paths.directory,'host-setup.json'),JSON.stringify({kind:result.kind,installed:result.installed,message:result.message}),{mode:0o600});}).catch(e=>{failure=e.message;hostState.message='Setup needs attention.';}).finally(()=>{hostBusy=false;});return {started:true};
    }
    if(op==='login'){
      if(hostBusy||hostState?.kind!=='codex'||!hostState.host)throw new Error('Set up Codex first.');hostBusy=true;hostState.message='Complete sign-in in the browser opened by Codex.';
      const host=hostState.host;
      void exec(host.command,[...host.prefix,'login'],{env:cleanEnvironment(),timeout:300000}).then(async()=>{hostState.auth=await codexStatus(host);hostState.message=hostState.auth==='signed_in'?'Signed in with ChatGPT. Start a new Codex conversation with Recruiters.rip.':'Sign in with a ChatGPT subscription to use this connection.';}).catch(()=>{hostState.message='Sign-in was not completed. Open Sign in with ChatGPT when you are ready.';}).finally(()=>{hostBusy=false;});return {started:true};
    }
    if(op==='backup'){const s=store.get();return {filename:'recruiters-career-backup.json',data:JSON.stringify({version:1,exportedAt:new Date().toISOString(),account:s.pairing?.account,career:s.career,archives:Object.entries(s.identityArchives??{}).map(([deviceId,a])=>({deviceId,account:a.pairing?.account,career:a.career}))},null,2)};}
    if(op==='exports'){await privateDirectory(files.exportDirectory());return {directory:files.exportDirectory(),resources:await files.listResources()};}
    if(op==='read-export'){return files.readResource(input.uri);}
    if(op==='reset'){
      if(!await requestApproval('Disconnect this account?', 'Your saved career data will be archived on this computer. The next account starts with an empty profile. Revoke this device on the website separately.'))return {cancelled:true};
      sessionEpoch++;bridge.disconnect();const result=await vault.resetIdentity();pauseRequested=false;return result;
    }
    throw new Error('This control is not available.');
  }
  try {
    control=await controlServer({paths,invoke,pair,pairingState(value){if(typeof value!=='string'||!pairState||Date.now()>pairState.expiresAt||Buffer.byteLength(value)!==Buffer.byteLength(pairState.value)||!timingSafeEqual(Buffer.from(value),Buffer.from(pairState.value)))return false;pairState=null;return true;},async fileSelection(input){
      assertAvailable(true);if(!sourceRequest||input.id!==sourceRequest.id)throw new Error('The CV selection expired. Ask your AI app to select a CV again.');
      if(input.cancel){sourceRequest.finish(null);return {cancelled:true};}
      if(typeof input.name!=='string'||input.name.length>255||typeof input.base64!=='string'||input.base64.length>7*1024*1024||!/^[A-Za-z0-9+/]*={0,2}$/.test(input.base64))throw new Error('Choose a PDF, DOCX or text CV smaller than 5 MiB.');
      const buffer=Buffer.from(input.base64,'base64'),mimetype={'.pdf':'application/pdf','.docx':'application/vnd.openxmlformats-officedocument.wordprocessingml.document','.txt':'text/plain'}[path.extname(input.name).toLowerCase()];
      if(!mimetype||!buffer.length||buffer.length>5*1024*1024)throw new Error('Choose a PDF, DOCX or text CV smaller than 5 MiB.');
      sourceRequest.finish({buffer,originalname:path.basename(input.name),mimetype,size:buffer.length});return {selected:true};
    }});
    try { const saved=JSON.parse(await readFile(path.join(paths.directory,'host-setup.json'),'utf8')); if(saved.installed&&['codex','claude'].includes(saved.kind)){hostState=saved;if(saved.kind==='codex'){hostState.host=await findCodex(paths.base);hostState.auth=hostState.host?await codexStatus(hostState.host):'sign_in_required';}} }catch{}
    try { await initialize(); } catch(e){failure=e.message;}
    bridge=await startMcpBroker({directory:paths.directory,createServer:createSessionServer,onConnections:count=>{mcpConnections=count;}});
    stopScreenMonitor=monitor(()=>locked?undefined:invoke('lock'));
    heartbeat=setInterval(()=>{if(locked||heartbeatBusy||!store.get().pairing)return;heartbeatBusy=true;void client.request('POST','/device/heartbeat',{}).catch(()=>{}).finally(()=>{heartbeatBusy=false;});},30000);
    return {control,close,status,invoke};
  } catch(e){await close();throw e;}
}
