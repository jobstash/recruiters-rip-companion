'use strict';
const $=id=>document.getElementById(id),fragment=new URLSearchParams(location.hash.slice(1));
const token=fragment.get('token')||sessionStorage.getItem('recruiters-control');
if(fragment.has('token'))sessionStorage.setItem('recruiters-control',token);
history.replaceState(null,'',location.pathname);
let state,refreshing=false;
const message=text=>{$('notice').textContent=text;};
const error=text=>{$('error').textContent=text;$('error').hidden=!text;};
async function post(url,body){const res=await fetch(url,{method:'POST',headers:{'content-type':'application/json',...(token?{authorization:`Bearer ${token}`}:{})},body:JSON.stringify(body)});const result=await res.json();if(!res.ok||!result.ok)throw new Error(result.error?.message||result.error||'The companion is not available.');return result.result;}
const invoke=(op,input={})=>post('/action',{op,input});
async function refresh(){
 if(refreshing)return;refreshing=true;
 try{
  state=await invoke('state');$('storage').hidden=!state.locked;$('controls').hidden=state.locked;$('storage-message').textContent=state.failure||'Unlock your operating system keychain, then open local storage.';
  $('account').textContent=state.paired?`Connected as ${state.account.label}`:'No account connected.';$('account-button').textContent=state.paired?'Open account connection':'Connect account';
  $('host-status').textContent=state.host?.message||'Choose your AI app. Setup installs the career skill and local tools.';
  $('codex').disabled=state.hostBusy;$('claude').disabled=state.hostBusy;$('login').hidden=!state.host?.installed||state.host?.kind!=='codex'||state.host.auth==='signed_in';$('login').disabled=state.hostBusy;$('conversation').hidden=!state.host?.installed;
  $('connection').textContent=state.paused?'Changes paused. Saved records remain readable.':state.mcpConnections?`${state.mcpConnections} AI connection${state.mcpConnections===1?'':'s'} active.`:'Ready. Your AI app will connect when you use Recruiters.rip.';$('pause').textContent=state.paused?'Resume changes':'Pause changes';
  if(state.approval){$('approval-title').textContent=state.approval.title;$('approval-detail').textContent=state.approval.detail;$('allow').textContent=state.approval.title.startsWith('Disconnect')?'Disconnect account':'Connect account';if(!$('approval-dialog').open)$('approval-dialog').showModal();}else if($('approval-dialog').open)$('approval-dialog').close();
  if(state.sourceRequest&&!state.locked){if(!$('file-dialog').open){$('source').value='';$('file-dialog').showModal();}}else if($('file-dialog').open)$('file-dialog').close();
  if(state.failure)error(state.failure);
 }catch(e){error(e.message);}finally{refreshing=false;}
}
async function action(op,input={}){error('');try{const result=await invoke(op,input);await refresh();return result;}catch(e){error(e.message);throw e;}}
for(const button of document.querySelectorAll('[data-op]'))button.onclick=()=>{void action(button.dataset.op).catch(()=>{});};
$('codex').onclick=()=>void action('install-host',{kind:'codex'}).catch(()=>{});$('claude').onclick=()=>void action('install-host',{kind:'claude'}).catch(()=>{});$('login').onclick=()=>void action('login').catch(()=>{});$('pause').onclick=()=>void action(state?.paused?'resume':'pause').catch(()=>{});
$('stop').onclick=async()=>{try{await invoke('stop');clearInterval(poll);$('controls').hidden=true;message('Companion stopped. Run the setup command to open it again.');}catch(e){error(e.message);}};
function download(bytes,type,name){const url=URL.createObjectURL(new Blob([bytes],{type})),link=document.createElement('a');link.href=url;link.download=name;link.click();setTimeout(()=>URL.revokeObjectURL(url),30000);}
$('backup').onclick=async()=>{try{const r=await action('backup');download(r.data,'application/json',r.filename);}catch{}};
$('exports').onclick=async()=>{try{const r=await action('exports');$('export-list').replaceChildren();if(!r.resources.length)message('No documents have been exported yet. Ask your AI app to prepare an application.');for(const item of r.resources){const li=document.createElement('li'),b=document.createElement('button');b.textContent=item.mimeType==='text/csv'?'Download saved job assessments':'Download exported PDF';b.onclick=async()=>{try{const doc=await action('read-export',{uri:item.uri});download(doc.blob?Uint8Array.from(atob(doc.blob),c=>c.charCodeAt(0)):doc.text,doc.mimeType,item.name);}catch{}};li.append(b);$('export-list').append(li);}}catch{}};
async function approval(allow){try{await action('approval',{id:state?.approval?.id,allow});}catch{}}
$('allow').onclick=()=>void approval(true);$('deny').onclick=()=>void approval(false);$('approval-dialog').oncancel=e=>{e.preventDefault();void approval(false);};
async function sendFile(cancel){try{const id=state?.sourceRequest?.id;if(cancel){await post('/source',{id,cancel:true});}else{const file=$('source').files[0];if(!file||file.size>5*1024*1024)throw new Error('Choose a CV file no larger than 5 MiB.');const bytes=new Uint8Array(await file.arrayBuffer());let binary='';for(let i=0;i<bytes.length;i+=16384)binary+=String.fromCharCode(...bytes.subarray(i,i+16384));await post('/source',{id,name:file.name,base64:btoa(binary)});}await refresh();}catch(e){error(e.message);}}
$('send-file').onclick=()=>void sendFile(false);$('cancel-file').onclick=()=>void sendFile(true);$('file-dialog').oncancel=e=>{e.preventDefault();void sendFile(true);};
if(fragment.has('payload')){try{const payload=JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(fragment.get('payload').replaceAll('-','+').replaceAll('_','/')),c=>c.charCodeAt(0))));void post('/pair',{payload,state:fragment.get('state')}).then(()=>message('Return to your companion controls to confirm this account.')).catch(e=>error(e.message));}catch{error('This account link is invalid. Open Connect account from your companion controls.');}}
if(!token){$('controls').hidden=true;message('Return to the companion controls opened during setup.');}
const poll=setInterval(()=>{if(token&&!document.hidden)void refresh();},2000);if(token)void refresh();
