param(
  [string]$Root,
  [string]$Checkout,
  [string]$Commit,
  [string]$Profile,
  [switch]$NoLaunch
)
$ErrorActionPreference = 'Stop'
# A pwsh -> Node -> Windows PowerShell chain can inherit incompatible module paths.
# Load the current shell's OS modules explicitly; do not alter the caller's path.
$previousModulePath = $env:PSModulePath
try {
  $env:PSModulePath = [IO.Path]::Combine($PSHOME, 'Modules')
  foreach ($moduleName in @('Microsoft.PowerShell.Management', 'Microsoft.PowerShell.Security')) {
    Import-Module -Name ([IO.Path]::Combine($PSHOME, 'Modules', $moduleName, ($moduleName + '.psd1'))) -Force -ErrorAction Stop
  }
} finally {
  $env:PSModulePath = $previousModulePath
}
# No elevation, global tool installation, or execution-policy modification.
foreach ($tool in @('git', 'node', 'npm')) {
  if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) {
    throw "Install Git and Node.js 24 (including npm), then run this command again. Missing: $tool"
  }
}
$nodeVersion = & node --version
if ($LASTEXITCODE -ne 0 -or $nodeVersion -notmatch '^v24\.') { throw 'Node.js 24 is required.' }
$installerArgs = @()
if ($Root) { $installerArgs += @('--root', $Root) }
if ($Checkout) { $installerArgs += @('--checkout', $Checkout) }
if ($Commit) { $installerArgs += @('--commit', $Commit) }
if ($Profile) { $installerArgs += @('--profile', $Profile) }
if ($NoLaunch) { $installerArgs += '--no-launch' }
$work = Join-Path ([IO.Path]::GetTempPath()) ('recruiters-source-' + [Guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($work) | Out-Null
try {
  $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
  $acl = Get-Acl -LiteralPath $work
  $allowed = @($sid.Value, 'S-1-5-18', 'S-1-5-32-544')
  if ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -notin $allowed) { throw 'The bootstrap directory has a foreign owner.' }
  $acl.SetAccessRuleProtection($true, $false)
  foreach ($rule in @($acl.Access)) { $acl.RemoveAccessRuleSpecific($rule) }
  foreach ($identity in $allowed) {
    $rule = [Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($identity), [Security.AccessControl.FileSystemRights]::FullControl, ([Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit), [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow)
    $acl.AddAccessRule($rule)
  }
  Set-Acl -LiteralPath $work -AclObject $acl
  $privateAcl = Get-Acl -LiteralPath $work
  if (-not $privateAcl.AreAccessRulesProtected) { throw 'The bootstrap directory ACL still inherits public access.' }
  $ownerAccess = $false
  foreach ($rule in $privateAcl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
    if ($rule.AccessControlType -eq 'Allow') {
      if ($rule.IdentityReference.Value -notin $allowed) { throw 'The bootstrap directory is not private.' }
      if ($rule.IdentityReference.Value -eq $sid.Value) { $ownerAccess = $true }
    }
  }
  if (-not $ownerAccess) { throw 'The bootstrap directory is missing owner access.' }
  if ($Checkout) {
    # Both bootstrap paths use the same private temporary-directory setup.
    # Validate before executing any candidate script, then validate again inside it.
    if ($Commit -notmatch '^[a-f0-9]{40}$') { throw 'A local checkout requires its exact -Commit.' }
    $head = & git '-C' $Checkout 'rev-parse' 'HEAD'
    if (($LASTEXITCODE -ne 0) -or ($head -ne $Commit)) { throw 'The local checkout does not match -Commit.' }
    $dirty = & git '-C' $Checkout 'status' '--porcelain=v1' '--untracked-files=all'
    if ($LASTEXITCODE -ne 0 -or $dirty) { throw 'The explicit local checkout must be clean.' }
    & node (Join-Path $Checkout 'scripts/install-source.mjs') @installerArgs
    if ($LASTEXITCODE -ne 0) { throw 'Source installation failed.' }
    return
  }
  $base = 'https://github.com/jobstash/recruiters-rip-companion/releases/latest/download'
  $script = Join-Path $work 'install-source.mjs'
  $sums = Join-Path $work 'SHA256SUMS.txt'
  # Fetch through Node so TLS, bounded output and redirect allowlists are identical on Windows.
  $fetch = @'
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
(async () => {
  async function download(name) {
    let url = process.argv[1] + '/' + name;
    for (let redirects = 0; redirects < 6; redirects++) {
      const parsed = new URL(url);
      if (parsed.protocol !== 'https:' || parsed.username || parsed.password || (parsed.port && parsed.port !== '443') || !['github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com'].includes(parsed.hostname)) throw new Error('Invalid bootstrap redirect.');
      const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(120000) });
      if ([301,302,303,307,308].includes(response.status)) { url = new URL(response.headers.get('location'), url).href; await response.body.cancel(); continue; }
      if (!response.ok) throw new Error('Source bootstrap download failed: ' + response.status);
      let length = 0; const chunks = [];
      for await (const chunk of response.body) { length += chunk.length; if (length > 1048576) throw new Error('Source bootstrap is too large.'); chunks.push(Buffer.from(chunk)); }
      const body = Buffer.concat(chunks);
      await fs.writeFile(path.join(process.argv[2], name), body, { flag: 'wx' });
      return body;
    }
    throw new Error('Too many bootstrap redirects.');
  }
  const script = await download('install-source.mjs');
  const sums = (await download('SHA256SUMS.txt')).toString('utf8').split(/\r?\n/).filter(line => /^[a-f0-9]{64}  install-source\.mjs$/.test(line));
  if (sums.length !== 1 || crypto.createHash('sha256').update(script).digest('hex') !== sums[0].slice(0,64)) throw new Error('The source bootstrap checksum did not match the official release.');
})().catch(error => { console.error(error.message); process.exitCode = 1; });
'@
  & node -e $fetch $base $work
  if ($LASTEXITCODE -ne 0) { throw 'The official source bootstrap could not be verified.' }
  & node $script @installerArgs
  if ($LASTEXITCODE -ne 0) { throw 'Source installation failed.' }
} finally {
  foreach ($name in @('install-source.mjs', 'SHA256SUMS.txt')) {
    $file = Join-Path $work $name
    if ([IO.File]::Exists($file)) { [IO.File]::Delete($file) }
  }
  [IO.Directory]::Delete($work)
}
