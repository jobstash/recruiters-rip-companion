param([Parameter(Mandatory=$true)][string]$Journal)
$ErrorActionPreference = 'Stop'
# Runs in Windows PowerShell, never the installed Electron executable: NSIS can
# uninstall every old binary without the updater holding an executable/DLL lock.
$j = Get-Content -LiteralPath $Journal -Raw | ConvertFrom-Json
$work = Split-Path -Parent $Journal
$exclusion = $null
function Acquire-Exclusion {
  if ($script:exclusion) { return $true }
  try {
    # maxInstances=1 also refuses an existing Node/libuv ordinary-startup pipe.
    $script:exclusion = New-Object IO.Pipes.NamedPipeServerStream($j.lock.pipe, [IO.Pipes.PipeDirection]::InOut, 1)
    return $true
  } catch { return $false }
}
function Release-Exclusion {
  if ($script:exclusion) { $script:exclusion.Dispose(); $script:exclusion = $null }
}
function Assert-Real([string]$p, [bool]$directory) {
  $item = Get-Item -LiteralPath $p -Force
  if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $item.PSIsContainer -ne $directory -or $item.FullName -cne $p) { throw 'Unsafe update path' }
  $parent = $item.Directory
  if ($directory) { $parent = $item.Parent }
  while ($parent) {
    if ($parent.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Linked update parent' }
    $parent = $parent.Parent
  }
}
function Confirmed {
  $file = Join-Path $work 'confirmed.json'
  if (!(Test-Path -LiteralPath $file)) { return $false }
  Assert-Real $file $false
  $proof = Get-Content -LiteralPath $file -Raw | ConvertFrom-Json
  return $proof.id -ceq $j.id -and $proof.version -ceq $j.version
}
function Receipt([string]$status) {
  if (Confirmed) { $status = 'confirmed' }
  $j.status = $status
  $j.updatedAt = [DateTime]::UtcNow.ToString('o')
  $temp = "$Journal.ps-tmp"
  [IO.File]::WriteAllText($temp, ($j | ConvertTo-Json -Compress), (New-Object Text.UTF8Encoding($false)))
  # MoveFileEx replacement is atomic; File.Replace works for the existing receipt.
  [IO.File]::Replace($temp, $Journal, $null)
}
function Target-Processes {
  @(Get-Process | Where-Object { try { $_.Path -and $_.Path.StartsWith($j.target + '\', [StringComparison]::OrdinalIgnoreCase) } catch { $false } })
}
function Restore {
  if ((Target-Processes).Count) { Receipt 'unconfirmed'; return }
  if (!(Acquire-Exclusion)) { Receipt 'unconfirmed'; return }
  Assert-Real $j.backup $true
  if (Test-Path -LiteralPath $j.staged) { throw 'Rollback staging is occupied' }
  if (Test-Path -LiteralPath $j.target) {
    Assert-Real $j.target $true
    Move-Item -LiteralPath $j.target -Destination $j.staged
  }
  Move-Item -LiteralPath $j.backup -Destination $j.target
  if (Test-Path -LiteralPath $registration.PSPath) {
    Set-ItemProperty -LiteralPath $registration.PSPath -Name DisplayVersion -Value $j.previousVersion
  }
  Receipt 'rolled-back'
  Release-Exclusion
  Start-Process -FilePath (Join-Path $j.target $j.executable) -ArgumentList @("--user-data-dir=`"$($j.userData)`"") -WorkingDirectory $j.target | Out-Null
}
$changed = $false
try {
  if ($j.schema -ne 1 -or $j.platform -cne 'win32' -or $j.id -cnotmatch '^[a-f0-9]{32}$' -or $j.digest -cnotmatch '^[a-f0-9]{64}$' -or $j.pid -lt 1 -or $j.status -cne 'staged') { throw 'Invalid receipt' }
  $parent = Split-Path -Parent $j.target
  if ($Journal -cne $j.journal -or (Split-Path -Leaf $work) -cne "install-$($j.id)" -or $j.staged -cne (Join-Path $parent ".recruiters-update-$($j.id)") -or $j.backup -cne (Join-Path $parent ".recruiters-backup-$($j.id)") -or $j.installer -cne (Join-Path $work 'installer.exe') -or $j.executable -cne 'Recruiters.rip Companion.exe') { throw 'Invalid update paths' }
  if ($j.userData -cne (Split-Path -Parent (Split-Path -Parent $work))) { throw 'Invalid update profile' }
  $sha = [Security.Cryptography.SHA256]::Create()
  try { $identity = [BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($j.target.ToLowerInvariant()))).Replace('-', '').ToLowerInvariant() } finally { $sha.Dispose() }
  if ($j.lock.pipe -cne "RecruitersCompanionInstallation-$identity") { throw 'Invalid installation exclusion' }
  Assert-Real $work $true; Assert-Real $Journal $false; Assert-Real $j.target $true; Assert-Real $j.installer $false
  if ((Test-Path -LiteralPath $j.backup) -or (Test-Path -LiteralPath $j.staged)) { throw 'Recovery paths occupied' }
  # electron-builder puts InstallLocation in its private install key, not the
  # standard uninstall key. The quoted registered uninstaller binds this target.
  # NSIS's default display name includes the registered version.
  $registrations = @(Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*' -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -eq ('Recruiters.rip Companion ' + $_.DisplayVersion) -and $_.UninstallString -match '^"([^"]+)"' -and [IO.Path]::GetDirectoryName($Matches[1]) -eq $j.target })
  if ($registrations.Count -ne 1) { throw 'Not the registered per-user installation' }
  $registration = $registrations[0]
  Assert-Real ([regex]::Match($registration.UninstallString, '^"([^"]+)"').Groups[1].Value) $false
  $machine = @(Get-ItemProperty 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*' -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -eq ('Recruiters.rip Companion ' + $_.DisplayVersion) })
  if ($machine.Count) { throw 'Machine installation requires an administrator' }
  if ((Get-FileHash -LiteralPath $j.installer -Algorithm SHA256).Hash.ToLowerInvariant() -cne $j.digest) { throw 'Installer checksum mismatch' }
  [IO.File]::WriteAllText((Join-Path $work 'ready'), $j.id)
  $deadline = [DateTime]::UtcNow.AddSeconds(30)
  while (!(Test-Path -LiteralPath (Join-Path $work 'commit'))) {
    if ([DateTime]::UtcNow -gt $deadline -or !(Get-Process -Id $j.pid -ErrorAction SilentlyContinue)) { throw 'Handover cancelled' }
    Start-Sleep -Milliseconds 100
  }
  $deadline = [DateTime]::UtcNow.AddSeconds(120)
  while ((Get-Process -Id $j.pid -ErrorAction SilentlyContinue) -or (Target-Processes).Count) {
    if ([DateTime]::UtcNow -gt $deadline) { throw 'Old application did not exit' }
    Start-Sleep -Milliseconds 200
  }
  if (!(Acquire-Exclusion)) { Receipt 'unconfirmed'; exit 0 }
  Assert-Real $j.target $true
  if ((Test-Path -LiteralPath $j.backup) -or (Test-Path -LiteralPath $j.staged)) { throw 'Recovery paths changed during handover' }
  Get-ChildItem -LiteralPath $j.target -Recurse -Force | ForEach-Object { if ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Linked installation contents' } }
  Copy-Item -LiteralPath $j.target -Destination $j.backup -Recurse
  Receipt 'installing'
  Assert-Real $j.installer $false
  if ((Get-FileHash -LiteralPath $j.installer -Algorithm SHA256).Hash.ToLowerInvariant() -cne $j.digest) { throw 'Installer checksum mismatch' }
  $changed = $true
  # electron-builder assisted NSIS: /S disables UI; /currentuser prevents
  # elevation; --updated preserves shortcuts/data. Do NOT pass --force-run:
  # this independent helper must observe the restarted process itself.
  # NSIS requires unquoted /D= as the final argument, even with spaces.
  $setup = Start-Process -FilePath $j.installer -ArgumentList @('/S', '/currentuser', '--updated', "/D=$($j.target)") -PassThru -Wait
  if ($setup.ExitCode -ne 0) { throw 'NSIS installation failed' }
  Assert-Real $j.target $true
  Assert-Real (Join-Path $j.target $j.executable) $false
  Receipt 'launching'
  Release-Exclusion
  $app = Start-Process -FilePath (Join-Path $j.target $j.executable) -ArgumentList @("--user-data-dir=`"$($j.userData)`"") -WorkingDirectory $j.target -PassThru
  $j | Add-Member -NotePropertyName launchedPid -NotePropertyValue $app.Id -Force
  Receipt 'launched'
  $deadline = [DateTime]::UtcNow.AddSeconds(120)
  while (!(Confirmed)) {
    if ($app.HasExited) { throw 'Updated application exited before startup' }
    if ([DateTime]::UtcNow -gt $deadline) { Receipt 'unconfirmed'; exit 0 }
    Start-Sleep -Milliseconds 250
    $app.Refresh()
  }
  Receipt 'confirmed'
} catch {
  try {
    if (Confirmed) { Receipt 'confirmed' }
    elseif ($changed -and (Test-Path -LiteralPath $j.backup)) { Restore }
    else { Receipt 'failed' }
  } catch { # Preserve both app and backup if recovery itself cannot complete.
    try { Receipt 'unconfirmed' } catch {}
  }
  exit 1
} finally { Release-Exclusion }
