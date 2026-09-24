# isolated-probe.ps1 -- the reviewable, bounded procedure for the one host-wide setting in
# ..\HOST-PREREQ.md. It is written to be read before it is run.
#
# ORDER: preflight (reads only, writes nothing) -> apply the setting (ONLY with -Approve) -> one probe
# -> restore. Without -Approve the run stops after the preflight and writes nothing at all, including
# in its cleanup: a read-only run that "restored" a setting it never changed would itself be a change.
#
# THE SETTING permits the VM worker to load an UNSIGNED, caller-supplied guest firmware image, and it
# is HOST-WIDE for every VM created while it is set. It is applied for the length of one probe.
#
# WHAT THIS DOES NOT DO: it creates, modifies or deletes no virtual machine other than the compute
# systems the probe itself creates, which are identified by the exact id prefix of this run; it never
# enumerates other VMs for action; it touches no Windows feature, boot configuration, BitLocker state
# or driver; it reboots nothing; it does not stop, restart or modify the live node.
#
# WHAT `finally` DOES AND DOES NOT COVER. It runs on a normal return, on a thrown error, on a failed
# preflight and on a probe timeout. It does NOT run if this PowerShell process is killed (Stop-Process,
# taskkill, a crash) or on power loss, and Ctrl-C handling in a native-child wait is not guaranteed
# either. If that happens with -Approve, the setting can be left applied: recovery is to check and
# remove it by hand, which the last section of HOST-PREREQ.md states as a residual risk rather than a
# covered case.
#
#   .\isolated-probe.ps1 -Image ...\openhcl-x64-test-linux-direct.bin -ImageSha256 d240f40c... [-Approve]
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string] $Image,
  [Parameter(Mandatory = $true)][string] $ImageSha256,
  [string] $Root = 'C:\Users\claude\vbs-like',
  [string] $EvidenceDir,
  [int]    $TimeoutSeconds = 180,
  # WHICH shapes to try, and the guest-state files they need. The defaults are the original run:
  # the IGVM path alone, no VMGS. They are parameters because the first approved run answered the
  # question it was built for - the firmware path is no longer refused, it now fails on the next
  # missing thing - and the shape that follows needs a different row and a file to point it at.
  [string] $Only = 'vbs-igvmpath',
  [string] $Vmgs,
  [string] $VmgsEmpty,
  # 1024 MB is the launcher's default and is small for a VTL2 paravisor plus a VTL0 guest.
  [int]    $MemMiB = 0,
  [switch] $Approve
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot 'isolated-probe.lib.ps1')

$RegPath  = 'HKLM:\Software\Microsoft\Windows NT\CurrentVersion\Virtualization'
$RegName  = 'AllowFirmwareLoadFromFile'
$NodeTask = 'EnclaveWindowsNode'
$HostExe  = Join-Path $Root 'target\release\vbslike-host.exe'
if (-not $EvidenceDir) { $EvidenceDir = Join-Path $Root ("out\iso-probe-" + (Get-Date -Format 'yyyyMMdd-HHmmss')) }

function Note([string] $s) { Write-Host "  $s" }
function Fail([string] $s) { throw "PREFLIGHT FAILED: $s" }

# --- reads of the live machine, each returning what the lib functions judge -------------------------
function Read-SettingState {
  $keyExists = Test-Path $RegPath
  $read = $null
  if ($keyExists) {
    try {
      $item = Get-ItemProperty -Path $RegPath -Name $RegName -ErrorAction Stop
      $kind = (Get-Item -Path $RegPath).GetValueKind($RegName)
      $read = @{ Ok = $true; Value = $item.$RegName; Kind = "$kind"; Error = $null }
    } catch {
      $read = @{ Ok = $false; Value = $null; Kind = $null; Error = "$($_.FullyQualifiedErrorId): $($_.Exception.Message)" }
    }
  }
  return Resolve-SettingState -KeyExists $keyExists -ValueRead $read
}

function Read-ImageAces([string] $path) {
  return @((Get-Acl -Path $path).Access | ForEach-Object {
    @{ Identity = "$($_.IdentityReference)"; Type = "$($_.AccessControlType)"; Rights = "$($_.FileSystemRights)" }
  })
}

function Invoke-LauncherProbe {
  $out = New-TemporaryFile; $err = New-TemporaryFile
  try {
    $p = Start-Process -FilePath $HostExe -ArgumentList 'probe' -PassThru -NoNewWindow -Wait `
           -RedirectStandardOutput $out -RedirectStandardError $err
    return Read-ProbeResult -ExitCode $p.ExitCode -Output (Get-Content $out -Raw)
  } finally { Remove-Item $out, $err -ErrorAction SilentlyContinue }
}

function Get-NodeHealth {
  $task = Get-ScheduledTask -TaskName $NodeTask -ErrorAction SilentlyContinue
  $procs = @(Get-Process ee-host, node, shielded-worker -ErrorAction SilentlyContinue | Select-Object -ExpandProperty ProcessName)
  return [pscustomobject]@{ TaskState = $(if ($task) { "$($task.State)" } else { 'missing' }); Processes = @($procs | Sort-Object) }
}
function Test-NodeUnchanged($before, $after) {
  return ($before.TaskState -eq $after.TaskState) -and (($before.Processes -join ',') -eq ($after.Processes -join ','))
}

New-Item -ItemType Directory -Force -Path $EvidenceDir | Out-Null
Start-Transcript -Path (Join-Path $EvidenceDir 'transcript.txt') | Out-Null

# $mutated is the ONLY thing that licenses a write in the cleanup block. It is set immediately before
# the one Set-ItemProperty in this script and nowhere else.
$mutated = $false
$script:probeOutcome = $null   # non-null when the probe itself failed or had to be killed
$script:runFailure = $null     # non-null when the try block threw: preserved for the exit status
$before = $null
$nodeBefore = $null
$probePrefix = $null
try {
  Write-Host "=== preflight (reads only; this phase writes nothing)"

  $principal = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
  if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { Fail 'not elevated' }
  Note 'elevated: yes'

  # the setting: Absent, Present and Error are distinguished; an unreadable value stops the run rather
  # than being treated as absent (and so, later, deleted)
  $before = Read-SettingState
  $before | ConvertTo-Json | Set-Content (Join-Path $EvidenceDir 'setting-before.json')
  if ($before.Status -eq 'Error') { Fail "the setting could not be read: $($before.Error). Refusing to proceed: an unreadable value must not be mistaken for an absent one" }
  Note ("setting before: " + $(if ($before.Status -eq 'Present') { "present, $($before.Kind) = $($before.Value)" } else { 'ABSENT' }))

  $nodeBefore = Get-NodeHealth
  $nodeBefore | ConvertTo-Json | Set-Content (Join-Path $EvidenceDir 'node-before.json')
  if ($nodeBefore.TaskState -ne 'Running') { Fail "the live node's task is $($nodeBefore.TaskState), not Running: refusing to touch a host whose node is already unhealthy" }
  Note ("live node: task Running, processes " + ($nodeBefore.Processes -join ' '))

  # no lab partition may be live. A crashed or malformed launcher is a failure, never "zero partitions"
  if (-not (Test-Path $HostExe)) { Fail "launcher not built at $HostExe" }
  $probe = Invoke-LauncherProbe
  if (-not $probe.Ok) { Fail "could not establish what compute systems exist: $($probe.Reason)" }
  $owned = @(Select-OwnedSystems -Systems $probe.Systems)
  if ($owned.Count -ne 0) { Fail "$($owned.Count) compute systems owned by vbslike already exist ($(($owned | ForEach-Object { $_.Id }) -join ', ')); destroy them first" }
  Note "no lab partitions exist ($($probe.Reason))"

  if (-not (Test-Path $Image)) { Fail "image not found: $Image" }
  $actual = (Get-FileHash -Algorithm SHA256 $Image).Hash.ToLower()
  if ($actual -ne $ImageSha256.ToLower()) { Fail "image sha256 is $actual, expected $ImageSha256" }
  Note "image sha256 verified: $actual"

  # the VM worker must be ALLOWED to read it, with nothing denying it; any ACE is not enough
  $access = Test-ImageReadAccess -Aces (Read-ImageAces $Image)
  if (-not $access.Ok) { Fail "the VM worker account cannot read $Image ($($access.Reason)); grant read before approving: icacls <image> /grant *S-1-5-83-0:(R)" }
  Note "image readable by the VM worker account ($($access.Reason))"

  if (-not $Approve) {
    Write-Host "=== preflight complete. Nothing was changed, and nothing will be written by this run."
    Write-Host "    With -Approve it would:"
    Write-Host "      1. set $RegName = 1 (REG_DWORD) under $RegPath  [HOST-WIDE, permits UNSIGNED guest firmware]"
    Write-Host "      2. run: vbslike-host isoprobe --only vbs-igvmpath --igvm $Image"
    Write-Host "      3. restore the setting to '$(if ($before.Status -eq 'Present') { "$($before.Kind)=$($before.Value)" } else { 'absent' })' and verify status, value and type"
    Write-Host "    Evidence: $EvidenceDir"
    return
  }

  Write-Host "=== applying the setting for the length of one probe"
  $mutated = $true              # set BEFORE the write: a write that half-happened must still be undone
  Set-ItemProperty -Path $RegPath -Name $RegName -Value 1 -Type DWORD
  (Read-SettingState) | ConvertTo-Json | Set-Content (Join-Path $EvidenceDir 'setting-applied.json')

  Write-Host "=== probe (creates and destroys its own partitions only)"
  # built here so the run's evidence can record exactly what was asked for
  $probeArgs = @('isoprobe', '--only', $Only, '--kernel', (Join-Path $Root 'wsl-kernel'),
                 '--initrd', (Join-Path $Root 'mon.cpio.gz'), '--igvm', $Image,
                 '--out', (Join-Path $EvidenceDir 'isoprobe'), '--seconds', '20')
  if ($Vmgs)      { $probeArgs += @('--vmgs', $Vmgs) }
  if ($VmgsEmpty) { $probeArgs += @('--vmgs-empty', $VmgsEmpty) }
  if ($MemMiB -gt 0) { $probeArgs += @('--mem', "$MemMiB") }
  Note ("image: $Image sha256 $ImageSha256")
  Note ("probe args: " + ($probeArgs -join ' '))
  $p = Start-Process -FilePath $HostExe -PassThru -NoNewWindow `
        -RedirectStandardOutput (Join-Path $EvidenceDir 'isoprobe.out') -RedirectStandardError (Join-Path $EvidenceDir 'isoprobe.err') `
        -ArgumentList $probeArgs
  # the partitions this run may clean up, and no others: the launcher names them after its own pid
  $probePrefix = "vbslike-iso-$($p.Id)-"
  $killed = $false
  if (-not $p.WaitForExit($TimeoutSeconds * 1000)) {
    Write-Warning "the probe exceeded ${TimeoutSeconds}s; killing it so the setting can be restored"
    $killed = $true
    $p | Stop-Process -Force -ErrorAction SilentlyContinue
    $p.WaitForExit(15000) | Out-Null
  }
  # the probe's own outcome is part of this run's result: a non-zero exit, or a timeout that had to be
  # killed, is a failure even when the cleanup afterwards is perfect
  # ExitCode on a Start-Process handle reads back EMPTY unless the object is refreshed after the
  # wait, which is how the first approved run reported "the probe exited " with no number and a
  # bare FAILED. Refresh, then treat an exit code we STILL cannot read as a failure rather than a
  # pass - an unreadable outcome is not a good one.
  try { $p.Refresh() } catch {}
  $code = $null
  try { $code = $p.ExitCode } catch {}
  $script:probeOutcome = if ($killed) { "the probe exceeded ${TimeoutSeconds}s and was killed" }
                         elseif ($null -eq $code) { "the probe's exit code could not be read" }
                         elseif ($code -ne 0) { "the probe exited $code" } else { $null }
  Note "probe exit code: $(if ($null -eq $code) { '<unreadable>' } else { $code })$(if ($killed) { ' (killed on timeout)' })"
}
catch {
  # remembered, not rethrown: rethrowing here would run the cleanup and then lose to whatever the
  # cleanup did. The exit status at the very end accounts for it.
  $script:runFailure = $_.Exception.Message
  Write-Host "=== run failed: $($script:runFailure)"
}
finally {
  Write-Host "=== cleanup"
  # Nothing in this block may terminate this block. The bug this replaced was exactly that: with
  # $ErrorActionPreference = 'Stop', a Write-Error (or a property access) in the reap step ended the
  # whole finally and the registry was never restored. So errors here are collected, the orchestration
  # lives in Invoke-ProbeCleanup where restoration sits in its own nested finally, and the failures are
  # reported once all three steps have been attempted.
  $ErrorActionPreference = 'Continue'
  $result = Invoke-ProbeCleanup -Mutated $mutated -Before $before `
    -Reap {
      $out = & $HostExe reap --prefix $probePrefix 2>&1 | Out-String
      $out | Set-Content (Join-Path $EvidenceDir 'reap.json')
      $parsed = $null
      try { $parsed = $out | ConvertFrom-Json } catch { }
      if ($null -eq $parsed) { throw "reap output is not JSON: $out" }
      Note ("reap: matched $(@(Get-Prop $parsed 'matched').Count), terminated $(@(Get-Prop $parsed 'terminated').Count) (prefix $probePrefix)")
      $parsed
    } `
    -Restore {
      if ($before.Status -eq 'Present') { Set-ItemProperty -Path $RegPath -Name $RegName -Value $before.Value -Type $before.Kind }
      else { Remove-ItemProperty -Path $RegPath -Name $RegName -ErrorAction SilentlyContinue }
    } `
    -ReadState {
      $now = Read-SettingState
      $now | ConvertTo-Json | Set-Content (Join-Path $EvidenceDir 'setting-after.json')
      $now
    } `
    -VerifyNode {
      $nodeAfter = Get-NodeHealth
      $nodeAfter | ConvertTo-Json | Set-Content (Join-Path $EvidenceDir 'node-after.json')
      @{ Ok = (Test-NodeUnchanged $nodeBefore $nodeAfter); Detail = "before $($nodeBefore | ConvertTo-Json -Compress) after $($nodeAfter | ConvertTo-Json -Compress)" }
    }

  Note ("steps attempted: " + ($result.Attempted -join ', '))
  if ($result.RestoreOk) {
    Note ($(if ($mutated) { "setting restored to " } else { "setting unchanged by this run (verified, not rewritten): " }) +
          $(if ($before.Status -eq 'Present') { "$($before.Kind)=$($before.Value)" } else { 'ABSENT' }) + " (status, value and type verified)")
  }
  if ($result.NodeOk) { Note "live node unchanged" }
  $result | ConvertTo-Json -Depth 4 | Set-Content (Join-Path $EvidenceDir 'cleanup.json')
  Note "evidence: $EvidenceDir"

  # Everything that makes this run a failure, gathered AFTER restoration and the node check have each
  # been attempted, so nothing above is skipped in order to report earlier.
  $all = @()
  if ($script:runFailure) { $all += $script:runFailure }
  if ($script:probeOutcome) { $all += $script:probeOutcome }
  $all += $result.Failures
  foreach ($f in $all) { Write-Error $f -ErrorAction Continue }
  if ($all.Count -gt 0) { Write-Host "RUN FAILED: $($all.Count) failure(s) above; state in $EvidenceDir\result.json" }
  else { Write-Host "RUN OK: preflight passed, cleanup complete, nothing left changed" }
  @{ Failures = $all; CleanupOk = $result.Ok; ProbeOutcome = $script:probeOutcome; RunFailure = $script:runFailure } |
    ConvertTo-Json -Depth 4 | Set-Content (Join-Path $EvidenceDir 'result.json')
  Stop-Transcript | Out-Null

  # The PROCESS status has to say so as well. Write-Error with -ErrorAction Continue leaves the exit
  # code at 0, so a caller checking status would read a failed run -- a probe that timed out, a
  # restoration that did not take -- as a success. This is the last statement in the script, after
  # every step above has run.
  if ($all.Count -gt 0) { exit 1 } else { exit 0 }
}
