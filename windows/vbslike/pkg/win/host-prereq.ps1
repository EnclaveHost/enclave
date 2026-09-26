# host-prereq.ps1 - the NucBox's M3 host prerequisites for the custom type-1 path, as a PERMANENT install with a verified
# rollback. Approved by enclave-87 under Steven's authority (2026-09-26) for package v41. RUN BY THE BOX OWNER ONLY
# (enclave-d1): the package's other scripts never change a host setting, and neither does this one unless -Install or
# -Rollback is given.
#
# The two settings (the same ones windows\vbslike\manager\ops\manager-accept.ps1 applies TEMPORARILY for each run):
#   1. HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Virtualization  AllowFirmwareLoadFromFile = 1 (DWORD)
#      Lets the VM worker load the firmware image a VM's configuration names (our measured IGVM). Hyper-V event 5142
#      names it; check.ps1 reports the igvm profile BLOCKED without it (HOST-PREREQ.md).
#   2. HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Virtualization\GuestCommunicationServices\
#        00002329-facb-11e6-bd58-64006a7986d3  (ElementName)  - the hv_sock service for port 9001 (0x2329), where the
#      report signer (wmiserve) answers the guest.
#
#   host-prereq.ps1 [-Check] [-Require]   read-only: prints both settings and the recorded prior state (default)
#   host-prereq.ps1 -Install              records the PRIOR state once, applies both, verifies
#   host-prereq.ps1 -Rollback             restores exactly the recorded prior state, verifies, retires the record
#
# The prior state is recorded OUTSIDE the package (C:\Users\claude\vbs-like\host-prereq\prior-state.json), written by the
# first -Install only, with the registry root it describes: a later -Install never overwrites it, and an -Install or
# -Rollback against another root than the record's is refused. Refused while an acceptance run holds the shared lock
# (C:\Users\claude\uefi-probe.lock), whose harness applies and restores the same settings. The lock is taken the way
# the harnesses take it, by OPENING the file with no sharing (manager-accept.ps1, manager-launcher-canary.ps1): the file
# itself outlives every run, so its existence means nothing (enclave-63's review). It is HELD from before the state is
# read until after the verify, so no run can start mid-install, and released at exit.
# -Rollback undoes only what -Install set, and only while it is still exactly that (enclave-d1's review):
#   - the value: restored to its recorded prior state only while it is still DWORD 1 (what -Install set);
#   - the 9001 service key: removed only if it was absent before the install AND its ElementName is still this script's
#     (WMISERVE-PROTOCOL.md: never remove a GUID somebody else registered); a key that existed before is never touched.
#   Anything left for those reasons is printed as "LEFT: ..." and the rollback exits 4 (not verified-equal).
# A REHEARSAL (-RegRoot on an HKCU key) needs that key to exist first (New-Item <key>), and needs its own -RecordDir: the
# default record directory is refused in rehearsal, so a rehearsal record can never be taken for the real one.
# Nothing else is written: no reboot, no service restart, no file outside that record directory.
#
# -Install (on HKLM) also refuses unless this boot has Secure Boot ON (Confirm-SecureBootUEFI) and test signing and
# nointegritychecks are off in both `bcdedit /enum {current}` and `{hypervisorsettings}` (an absent line is off). The
# lane's rule: the custom type-1 path runs under Secure Boot only. -Rollback is never refused for that.
#
# Exit: 0 done and verified (or -Check); 1 a write did not verify; 2 refused (lock held, not elevated, no record, a record
# for another root, Secure Boot off or test signing on for -Install, a precondition); 3 -Check -Require and the settings
# are not installed; 4 -Rollback restored what it could and LEFT something another party changed or registered.
param(
  [switch] $Install,
  [switch] $Rollback,
  [switch] $Check,
  [switch] $Require,
  [string] $RecordDir = 'C:\Users\claude\vbs-like\host-prereq',
  # A REHEARSAL root: give an HKCU key (e.g. HKCU:\Software\EnclaveHostPrereqRehearsal) and a scratch -RecordDir to run the
  # whole install/check/rollback cycle on keys that change nothing, before the real HKLM run. HKLM is the default.
  [string] $RegRoot = 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Virtualization',
  [string] $Lock = 'C:\Users\claude\uefi-probe.lock'
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2

$RegPath = $RegRoot
$RegName = 'AllowFirmwareLoadFromFile'
$SvcPath = $RegRoot.TrimEnd('\') + '\GuestCommunicationServices'
$Rehearsal = -not $RegRoot.StartsWith('HKLM:', [System.StringComparison]::OrdinalIgnoreCase)
$SvcGuid = '00002329-facb-11e6-bd58-64006a7986d3'
$SvcKey = $SvcPath + '\' + $SvcGuid
$SvcName = 'enclave report signing (wmiserve, hv_sock port 9001)'
$DefaultRecordDir = 'C:\Users\claude\vbs-like\host-prereq'
$Record = $RecordDir.TrimEnd('\') + '\prior-state.json'   # a string join: Join-Path needs the drive to exist

function Say([string] $m) { Write-Output "host-prereq: $m" }
function Read-State {
  $fw = @{ S = 'Absent'; V = $null; K = $null }
  if (Test-Path $RegPath) {
    $item = Get-ItemProperty $RegPath -EA SilentlyContinue
    if ($item -and ($item.PSObject.Properties.Name -contains $RegName)) {
      $fw = @{ S = 'Present'; V = [string]$item.$RegName; K = [string]((Get-Item $RegPath).GetValueKind($RegName)) }
    }
  }
  $svc = @{ S = 'Absent'; ElementName = $null }
  if (Test-Path $SvcKey) {
    $e = Get-ItemProperty $SvcKey -EA SilentlyContinue
    $n = $null; if ($e -and ($e.PSObject.Properties.Name -contains 'ElementName')) { $n = [string]$e.ElementName }
    $svc = @{ S = 'Present'; ElementName = $n }
  }
  return @{ fw = $fw; svc = $svc }
}
function Show([string] $label, $st) {
  $fwv = if ($st.fw.S -eq 'Present') { "Present $($st.fw.V) ($($st.fw.K))" } else { 'Absent' }
  $svv = if ($st.svc.S -eq 'Present') { "Present (ElementName '$($st.svc.ElementName)')" } else { 'Absent' }
  Say "$label AllowFirmwareLoadFromFile: $fwv"
  Say "$label hv_sock service ${SvcGuid} (port 9001): $svv"
}
function Installed($st) { return ($st.fw.S -eq 'Present' -and $st.fw.V -eq '1' -and $st.fw.K -eq 'DWord' -and $st.svc.S -eq 'Present') }
function Refuse([string] $m) { Say "REFUSED: $m"; exit 2 }
$script:lk = $null
function Assert-Writable {
  try { $script:lk = [System.IO.File]::Open($Lock, 'OpenOrCreate', 'ReadWrite', 'None') }
  catch { Refuse "an acceptance run holds $Lock (its harness applies and restores the same settings); run this after it ends" }
  if (-not $Rehearsal) {
    $admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    if (-not $admin) { Refuse 'not elevated: HKLM writes need an administrator PowerShell' }
  }
  if (-not (Test-Path $RegPath)) {
    if ($Rehearsal) { Refuse "the rehearsal root $RegPath does not exist: create it first (New-Item '$RegPath')" }
    Refuse "$RegPath does not exist (is the Hyper-V role installed?); this script creates no Virtualization key" }
}

if (($Install -or $Rollback) -and $Check) { Refuse 'give one of -Install, -Rollback or -Check' }
if ($Install -and $Rollback) { Refuse 'give one of -Install or -Rollback' }

if ($Rehearsal) { Say "REHEARSAL on $RegRoot (no Hyper-V setting is touched)" }
$now = Read-State
Show 'now:' $now
if (Test-Path $Record) { Say "prior-state record: $Record (written by the first -Install)" } else { Say 'prior-state record: none' }

if (-not $Install -and -not $Rollback) {
  if (Installed $now) { Say 'INSTALLED: both settings are in place' } else { Say 'NOT INSTALLED' }
  if ($Require -and -not (Installed $now)) { exit 3 }
  exit 0
}

if ($Rehearsal -and ($RecordDir.TrimEnd('\') -ieq $DefaultRecordDir)) {
  Refuse "a rehearsal needs its own -RecordDir: the default $DefaultRecordDir is the real record's" }
function Assert-BootPolicy {
  if ($Rehearsal) { Say 'rehearsal: the Secure Boot and test-signing checks are skipped'; return }
  $sb = $null
  try { $sb = Confirm-SecureBootUEFI } catch { Refuse "Secure Boot state unreadable ($($_.Exception.Message)): not installing" }
  if ($sb -ne $true) { Refuse 'Secure Boot is OFF on this boot: the custom type-1 path runs under Secure Boot only; not installing' }
  foreach ($store in @('{current}', '{hypervisorsettings}')) {
    $bcd = (& bcdedit.exe /enum $store 2>&1) -join "`n"
    if ($LASTEXITCODE -ne 0) { Refuse "bcdedit /enum $store failed: not installing" }
    if ($bcd -match '(?im)^\s*testsigning\s+Yes') { Refuse "test signing is ON in $store for this boot: not installing" }
    if ($bcd -match '(?im)^\s*nointegritychecks\s+Yes') { Refuse "nointegritychecks is ON in $store for this boot: not installing" }
  }
  Say 'boot policy: Secure Boot ON; test signing and nointegritychecks off in {current} and {hypervisorsettings}'
}

try {
  Assert-Writable
  # read again UNDER the lock: a run that was active at the first read could have had its temporary settings in place,
  # and -Install records this state as the prior one
  $now = Read-State
  Show 'under the lock:' $now
  if (Test-Path $Record) {
    $recRoot = [string](Get-Content -Raw $Record | ConvertFrom-Json).regRoot
    if ($recRoot -ne $RegRoot) { Refuse "the record at $Record describes ${recRoot}, not ${RegRoot}: refused" }
  }

  if ($Install) {
    Assert-BootPolicy
    if (-not (Test-Path $Record)) {
      New-Item -ItemType Directory -Path $RecordDir -Force | Out-Null
      $rec = [ordered]@{ type = 'enclave-nucbox-host-prereq/1'; at = (Get-Date).ToUniversalTime().ToString('o'); by = 'win\host-prereq.ps1 -Install';
                         package = (Split-Path -Leaf (Split-Path -Parent $PSScriptRoot)); regRoot = $RegRoot; svcElementName = $SvcName; before = $now }
      [System.IO.File]::WriteAllText($Record, ($rec | ConvertTo-Json -Depth 5))
      Say "RECORDED the prior state in $Record"
    } else { Say 'a prior-state record already exists: kept (a rollback returns to the state before the FIRST install)' }
    Set-ItemProperty -Path $RegPath -Name $RegName -Value 1 -Type DWord
    if (-not (Test-Path $SvcKey)) {
      New-Item -Path $SvcKey -Force | Out-Null
      New-ItemProperty -Path $SvcKey -Name 'ElementName' -Value $SvcName -PropertyType String -Force | Out-Null
      Say "registered the hv_sock service $SvcGuid"
    } else { Say "the hv_sock service $SvcGuid was already registered: left as it is" }
    $after = Read-State
    Show 'after:' $after
    if (Installed $after) { Say 'INSTALLED (verified). Rollback: win\host-prereq.ps1 -Rollback'; exit 0 }
    Say 'FAILED: the settings did not verify after the install'; exit 1
  }

  if ($Rollback) {
    if (-not (Test-Path $Record)) { Refuse "no prior-state record at ${Record}: nothing to roll back to" }
    $rec = Get-Content -Raw $Record | ConvertFrom-Json
    $b = $rec.before
    $left = @()
    Say "rolling back to the state recorded at $($rec.at) for $($rec.regRoot)"
    # the value: only while it is still exactly what -Install set (DWORD 1)
    if ($now.fw.S -eq 'Present' -and $now.fw.V -eq '1' -and $now.fw.K -eq 'DWord') {
      if ($b.fw.S -eq 'Present') { Set-ItemProperty -Path $RegPath -Name $RegName -Value $b.fw.V -Type $b.fw.K }
      else { Remove-ItemProperty -Path $RegPath -Name $RegName -EA SilentlyContinue }
    } elseif ($now.fw.S -ne $b.fw.S -or "$($now.fw.V)" -ne "$($b.fw.V)") {
      $left += "AllowFirmwareLoadFromFile is now $($now.fw.S) $($now.fw.V), not the DWORD 1 -Install set: changed since, left as it is"
    }
    # the 9001 key: only if it was absent before AND is still this script's (by ElementName)
    if ($b.svc.S -eq 'Absent' -and $now.svc.S -eq 'Present') {
      if ("$($now.svc.ElementName)" -eq "$SvcName") { Remove-Item -Path $SvcKey -Recurse -Force }
      else { $left += "the hv_sock service $SvcGuid is registered as '$($now.svc.ElementName)', not by this script: somebody else's, left as it is" }
    }
    $after = Read-State
    Show 'after:' $after
    foreach ($l in $left) { Say "LEFT: $l" }
    $okFw = ($after.fw.S -eq $b.fw.S) -and ("$($after.fw.V)" -eq "$($b.fw.V)")
    $okSvc = ($after.svc.S -eq $b.svc.S) -and ("$($after.svc.ElementName)" -eq "$($b.svc.ElementName)")
    if ($okFw -and $okSvc -and -not $left.Count) {
      $done = $RecordDir.TrimEnd('\') + '\prior-state.rolled-back-' + (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssZ') + '.json'
      Move-Item -Path $Record -Destination $done
      Say "ROLLED BACK (verified); the record is kept as $done"; exit 0
    }
    if ($left.Count) { Say 'ROLLED BACK what this script set; something changed by another party was LEFT (above); the record is kept'; exit 4 }
    Say 'FAILED: the restored state does not equal the recorded prior state; the record is kept'; exit 1
  }
} finally {
  if ($script:lk) { $script:lk.Dispose(); $script:lk = $null }
}
