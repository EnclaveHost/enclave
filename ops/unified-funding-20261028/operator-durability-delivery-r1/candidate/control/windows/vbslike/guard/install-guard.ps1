<#
  STAGED ONLY - permit r1. DO NOT RUN as part of this change. Nothing here has been executed; root/operators review and
  run it in a separate, explicitly authorized Windows step (WINDOWS-ACCEPTANCE-PERMIT.md W0).

  What it would do, in order, failing closed at each step:
    1. create the protected state directory with an explicit ACL (inheritance OFF; SYSTEM + Administrators full,
       the manager's service account modify) and refuse if the path or any ancestor is a reparse point;
    2. initialize BOTH owned logs exactly once (the guard's and the manager's) with initializeOwnedLog - it refuses an
       existing file, so a rerun never resets state;
    3. generate the two 32-byte keys (guestd-control/1 pairing key and the guard pipe key) into ACL'd files;
    4. print the exact SDDL of the journal files and their directory, which go into BOTH pinned configs (storage.sddl,
       storage.parentSddl) so the runtime probe compares them;
    5. register the guard to start at boot as SYSTEM, restarting on failure, BEFORE the manager.

  OPEN ITEMS (not solved by this script): Node is not a native Windows service; a reviewed service host (or this
  scheduled-task form) must be qualified, including what the Service Control Manager does on a guard crash loop. The
  pipe ACL is set by the guard creating the pipe under SYSTEM; restricting the pipe DACL to the manager's account needs
  a native pipe-security wrapper that node:net does not expose - until then the MAC is the only authentication.
#>
param(
  [Parameter(Mandatory)] [string] $StateDir,          # e.g. C:\ProgramData\Enclave\permit-r1
  [Parameter(Mandatory)] [string] $NodeExe,           # pinned node.exe
  [Parameter(Mandatory)] [string] $ReleaseDir,        # the hash-verified release containing control\windows\vbslike
  [Parameter(Mandatory)] [string] $ManagerAccount     # e.g. "NT SERVICE\EnclaveManager"
)
$ErrorActionPreference = 'Stop'
function Assert-NoReparse([string] $p) {
  $cur = Get-Item -LiteralPath $p -Force
  while ($cur) { if ($cur.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "reparse point in path: $($cur.FullName)" }; $cur = $cur.Parent }
}
if (-not (Test-Path -LiteralPath $StateDir)) { New-Item -ItemType Directory -Path $StateDir | Out-Null }
Assert-NoReparse $StateDir
if ((Get-Volume -FilePath $StateDir).FileSystem -ne 'NTFS' -or (Get-Volume -FilePath $StateDir).DriveType -ne 'Fixed') { throw 'state must be on a fixed NTFS volume' }
& icacls.exe $StateDir /inheritance:r /grant:r 'SYSTEM:(OI)(CI)F' 'Administrators:(OI)(CI)F' "${ManagerAccount}:(OI)(CI)M" | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'icacls failed' }

$init = Join-Path $ReleaseDir 'control\windows\vbslike\manager\win-durable.mjs'
$js = "import('file:///' + process.argv[1].replace(/\\/g,'/')).then(m => { m.initializeOwnedLog(process.argv[2], { purpose: process.argv[3] }); })"
foreach ($pair in @(@('guard.log','enclave-permit-guard/1'), @('manager-permit.log','enclave-manager-permit/1'))) {
  $file = Join-Path $StateDir $pair[0]
  if (Test-Path -LiteralPath $file) { throw "$file exists: an established journal is never re-initialized" }
  & $NodeExe --input-type=module -e $js $init $file $pair[1]
  if ($LASTEXITCODE -ne 0) { throw "journal initialization failed: $file" }
}
foreach ($k in @('control.key','guard.key')) {
  $file = Join-Path $StateDir $k
  if (Test-Path -LiteralPath $file) { throw "$file exists: keys are rotated by a separate reviewed step" }
  $b = New-Object byte[] 32; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b)
  [IO.File]::WriteAllText($file, (($b | ForEach-Object { $_.ToString('x2') }) -join '') + "`n")
}
@{ dir = (Get-Acl -LiteralPath $StateDir).Sddl
   guardLog = (Get-Acl -LiteralPath (Join-Path $StateDir 'guard.log')).Sddl
   managerLog = (Get-Acl -LiteralPath (Join-Path $StateDir 'manager-permit.log')).Sddl } | ConvertTo-Json

$guardMain = Join-Path $ReleaseDir 'control\windows\vbslike\guard\guard-main.mjs'
$action = New-ScheduledTaskAction -Execute $NodeExe -Argument "`"$guardMain`""
$trigger = New-ScheduledTaskTrigger -AtStartup
$settings = New-ScheduledTaskSettingsSet -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero)
Register-ScheduledTask -TaskName 'EnclavePermitGuard' -Action $action -Trigger $trigger -Settings $settings -User 'SYSTEM' -RunLevel Highest
# ENCLAVE_GUARD_CONFIG / _SHA256 must be set machine-wide for SYSTEM by the reviewed deployment step, not here.
