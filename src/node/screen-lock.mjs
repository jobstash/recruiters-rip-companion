import { exec } from './system.mjs';
import { cleanEnvironment } from './paths.mjs';
export async function screenLocked() {
  const options={env:cleanEnvironment(),timeout:3000,maxBuffer:1024*1024};
  if(process.platform==='darwin'){
    const {stdout}=await exec('/usr/sbin/ioreg',['-n','Root','-d1'],options);
    return /"CGSSessionScreenIsLocked"\s*=\s*Yes|"IOConsoleSessionScreenIsLocked"\s*=\s*Yes/.test(stdout);
  }
  if(process.platform==='linux'&&process.env.XDG_SESSION_ID){const {stdout}=await exec('loginctl',['show-session',process.env.XDG_SESSION_ID,'-p','LockedHint','--value'],options);return stdout.trim()==='yes';}
  if(process.platform==='win32'){
    const {stdout}=await exec('powershell.exe',['-NoProfile','-NonInteractive','-Command','[bool](Get-Process LogonUI -ErrorAction SilentlyContinue)'],options);return stdout.trim()==='True';
  }
  return false;
}
export function watchScreenLock(onLock,read=screenLocked){let busy=false,wasLocked=false;const timer=setInterval(async()=>{if(busy)return;busy=true;try{const locked=await read();if(locked&&!wasLocked)await onLock();wasLocked=locked;}catch{/* Keychain and manual lock remain authoritative if the OS session is unavailable. */}finally{busy=false;}},2000);timer.unref();return()=>clearInterval(timer);}
