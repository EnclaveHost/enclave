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
  $p = Start-Process -FilePath $HostExe -PassThru -NoNewWindow `
        -RedirectStandardOutput (Join-Path $EvidenceDir 'isoprobe.out') -RedirectStandardError (Join-Path $EvidenceDir 'isoprobe.err') `
        -ArgumentList @('isoprobe', '--only', 'vbs-igvmpath', '--kernel', (Join-Path $Root 'wsl-kernel'),
                        '--initrd', (Join-Path $Root 'mon.cpio.gz'), '--igvm', $Image,
                        '--out', (Join-Path $EvidenceDir 'isoprobe'), '--seconds', '20')
  # the partitions this run may clean up, and no others: the launcher names them after its own pid
  $probePrefix = "vbslike-iso-$($p.Id)-"
  if (-not $p.WaitForExit($TimeoutSeconds * 1000)) {
    Write-Warning "the probe exceeded ${TimeoutSeconds}s; killing it so the setting can be restored"
    $p | Stop-Process -Force -ErrorAction SilentlyContinue
    $p.WaitForExit(15000) | Out-Null
  }
  Note "probe exit code: $($p.ExitCode)"
}
finally {
  Write-Host "=== cleanup"

  # 1. a partition this run's probe may have left behind, if it was killed mid-flight. Only ids with
  #    this run's prefix are candidates; `reap` refuses anything else.
  if ($mutated -and $probePrefix) {
    try {
      $r = & $HostExe reap --prefix $probePrefix 2>&1 | Out-String
      $r | Set-Content (Join-Path $EvidenceDir 'reap.json')
      $rj = $null; try { $rj = $r | ConvertFrom-Json } catch {}
      if ($null -ne $rj -and $rj.ok) {
        Note ("reap: matched $($rj.matched.Count), terminated $($rj.terminated.Count) (prefix $probePrefix)")
      } else {
        Write-Error "REAP FAILED for $probePrefix; a partition of this run may still be running. Check with: $HostExe probe. Output: $r"
      }
    } catch { Write-Error "REAP FAILED for ${probePrefix}: $_" }
  }

  # 2. the setting. A write here is licensed ONLY by this run having made one.
  if ($mutated) {
    if ($before.Status -eq 'Present') { Set-ItemProperty -Path $RegPath -Name $RegName -Value $before.Value -Type $before.Kind }
    else { Remove-ItemProperty -Path $RegPath -Name $RegName -ErrorAction SilentlyContinue }
    $now = Read-SettingState
    $now | ConvertTo-Json | Set-Content (Join-Path $EvidenceDir 'setting-after.json')
    if (Test-SettingRestored -Before $before -Now $now) {
      Note ("setting restored to " + $(if ($before.Status -eq 'Present') { "$($before.Kind)=$($before.Value)" } else { 'ABSENT' }) + " (status, value and type verified)")
    } else {
      Write-Error "THE SETTING WAS NOT RESTORED. Expected $($before | ConvertTo-Json -Compress), found $($now | ConvertTo-Json -Compress). Remove it by hand: Remove-ItemProperty '$RegPath' -Name $RegName"
    }
  } elseif ($null -ne $before) {
    # read-only run: VERIFY the state is what the preflight saw, and write nothing either way
    $now = Read-SettingState
    $now | ConvertTo-Json | Set-Content (Join-Path $EvidenceDir 'setting-after.json')
    if (Test-SettingRestored -Before $before -Now $now) { Note "setting unchanged by this run (verified, not rewritten): $($now.Status)" }
    else { Write-Error "THE SETTING CHANGED during a run that never wrote it: before $($before | ConvertTo-Json -Compress), now $($now | ConvertTo-Json -Compress). Something else on this host changed it." }
  } else {
    Note 'nothing to verify: the run stopped before the setting was read'
  }

  # 3. the live node, unchanged
  if ($null -ne $nodeBefore) {
    $nodeAfter = Get-NodeHealth
    $nodeAfter | ConvertTo-Json | Set-Content (Join-Path $EvidenceDir 'node-after.json')
    if (Test-NodeUnchanged $nodeBefore $nodeAfter) { Note "live node unchanged: task $($nodeAfter.TaskState), processes $($nodeAfter.Processes -join ' ')" }
    else { Write-Error "THE LIVE NODE CHANGED: before $($nodeBefore | ConvertTo-Json -Compress) after $($nodeAfter | ConvertTo-Json -Compress)" }
  }
  Note "evidence: $EvidenceDir"
  Stop-Transcript | Out-Null
}
