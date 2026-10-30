#!/usr/bin/env node
// Copied to the private managed root; never points at an arbitrary checkout.
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';

// Bootstrap trust must be established with built-ins, before loading checkout code.
// Keep this policy aligned with assertWindowsSourcePath in install-source.mjs.
function assertWindowsSourcePath(filename, { privateLeaf = false, file = false } = {}) {
  const encoded = Buffer.from(filename, 'utf8').toString('base64');
  const script = `$ErrorActionPreference='Stop';$p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}'));$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value;$allowed=@($sid,'S-1-5-18','S-1-5-32-544','S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464');$entries=@();$d=${file ? '[IO.Path]::GetDirectoryName($p)' : '$p'};while($d){$entries+=@{Path=$d;File=$false};$parent=[IO.Directory]::GetParent($d);if($null -eq $parent){break};$d=$parent.FullName};${file ? '$entries+=@{Path=$p;File=$true};' : ''}` +
    `$danger=[int64]([Security.AccessControl.FileSystemRights]::Delete -bor [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor [Security.AccessControl.FileSystemRights]::ChangePermissions -bor [Security.AccessControl.FileSystemRights]::TakeOwnership -bor [Security.AccessControl.FileSystemRights]::WriteAttributes -bor [Security.AccessControl.FileSystemRights]::WriteExtendedAttributes);$creation=[int64]([Security.AccessControl.FileSystemRights]::CreateFiles -bor [Security.AccessControl.FileSystemRights]::CreateDirectories);` +
    `foreach($entry in $entries){if(([IO.File]::GetAttributes($entry.Path) -band [IO.FileAttributes]::ReparsePoint) -ne 0){throw 'Linked source ancestor'};$a=if($entry.File){[IO.File]::GetAccessControl($entry.Path)}else{[IO.Directory]::GetAccessControl($entry.Path)};if($a.GetOwner([Security.Principal.SecurityIdentifier]).Value -notin $allowed){throw 'Foreign source ancestor owner'};$raw=[Security.AccessControl.RawSecurityDescriptor]::new($a.GetSecurityDescriptorBinaryForm(),0);if($null -eq $raw.DiscretionaryAcl){throw 'Unrestricted source ancestor'};$own=$false;foreach($r in $a.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])){if(($r.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly) -ne 0 -or $r.AccessControlType -ne 'Allow'){continue};$who=$r.IdentityReference.Value;if($who -eq $sid){$own=$true};if($who -notin $allowed){$rights=[int64]$r.FileSystemRights;if((${privateLeaf ? '$true' : '$false'} -and $entry.Path -eq $p) -or (($rights -band $danger) -ne 0) -or ($entry.File -and (($rights -band $creation) -ne 0))){throw 'Replaceable source path'}}};if(${privateLeaf ? '$true' : '$false'} -and $entry.Path -eq $p -and -not $own){throw 'Missing private owner access'}}`;
  const env = Object.fromEntries(['SystemRoot', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'USERPROFILE'].filter(key => process.env[key]).map(key => [key, process.env[key]]));
  const modules = "$ErrorActionPreference='Stop';$originalPSModulePath=$env:PSModulePath;try{$env:PSModulePath=[IO.Path]::Combine($PSHOME,'Modules');Import-Module -Name ([IO.Path]::Combine($PSHOME,'Modules','Microsoft.PowerShell.Management','Microsoft.PowerShell.Management.psd1')) -Force -ErrorAction Stop;Import-Module -Name ([IO.Path]::Combine($PSHOME,'Modules','Microsoft.PowerShell.Security','Microsoft.PowerShell.Security.psd1')) -Force -ErrorAction Stop}finally{$env:PSModulePath=$originalPSModulePath};";
  execFileSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(modules + script, 'utf16le').toString('base64')], { env, windowsHide: true, stdio: 'pipe', timeout: 15000, maxBuffer: 65536 });
}

const root = path.dirname(fileURLToPath(import.meta.url));
const info = await fs.lstat(root);
if (info.isSymbolicLink() || await fs.realpath(root) !== root || (process.getuid && (info.uid !== process.getuid() || (info.mode & 0o077)))) throw new Error('The managed source launcher is not private.');
if (process.platform === 'win32') assertWindowsSourcePath(root, { privateLeaf: true });
const read = async file => {
  const info = await fs.lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 65536) throw new Error('Invalid managed source pointer.');
  if (process.platform === 'win32') assertWindowsSourcePath(file, { privateLeaf: true, file: true });
  return JSON.parse(await fs.readFile(file, 'utf8'));
};
const marker = await read(path.join(root, 'managed.json'));
const current = await read(path.join(root, 'current.json'));
if (marker.schema !== 1 || marker.root !== root || marker.product !== 'rip.recruiters.companion' || current.schema !== 1 || typeof current.sourceRoot !== 'string' || path.dirname(path.dirname(current.sourceRoot)) !== path.join(root, 'versions') || path.basename(current.sourceRoot) !== 'source' || await fs.realpath(current.sourceRoot) !== current.sourceRoot) throw new Error('The source launcher target is invalid.');
const runtimeFile = path.join(current.sourceRoot, 'scripts', 'install-source.mjs');
if (process.platform === 'win32') assertWindowsSourcePath(runtimeFile, { privateLeaf: true, file: true });
const runtime = await import(pathToFileURL(runtimeFile).href);
await runtime.readManagedSource(current.sourceRoot, { version: current.version });
await runtime.validateSourceBuild(current.sourceRoot, current.version);
if (current.userData && (!path.isAbsolute(current.userData) || /[\0\r\n]/.test(current.userData))) throw new Error('Invalid source profile.');
const args = process.argv.slice(2);
if (args.some(arg => !['--inspect=127.0.0.1:0', '--remote-debugging-port=0', '--bridge', '--mcp-background'].includes(arg))) throw new Error('Unsupported source launcher argument.');
const child = spawn(runtime.sourceExecutable(current.sourceRoot), [current.sourceRoot, ...(current.userData ? [`--user-data-dir=${current.userData}`] : []), ...args], { detached: true, env: runtime.sourceEnvironment(), stdio: args.some(arg => arg.startsWith('--inspect=')) ? 'inherit' : 'ignore' });
await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
child.unref();
