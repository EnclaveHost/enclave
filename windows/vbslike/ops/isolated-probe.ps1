# isolated-probe.ps1 -- the reviewable, bounded procedure for the one host-wide setting in
# ..\HOST-PREREQ.md. It is written to be read before it is run.
#
# WHAT IT DOES, in order: preflight (changes nothing) -> apply the setting (ONLY with -Approve) ->
# run one probe -> restore the setting, ALWAYS, on every path including a failure, a probe timeout or
# Ctrl-C. Without -Approve it stops after the preflight and prints what it would have done, which is
# how it should be run first and how it was run on 2026-09-23.
#
# WHAT IT DOES NOT DO: it creates, modifies and deletes no virtual machine other than the compute
# systems the probe itself creates (owner "vbslike", name "vbslike-iso-*"); it never enumerates,
# inspects or alters any other VM; it touches no Windows feature, no boot configuration, no BitLocker
# state and no driver; it reboots nothing; it does not stop, restart or modify the live node.
#
# THE SETTING IT TOUCHES permits the VM worker to load an UNSIGNED, caller-supplied guest firmware
# image, and it is HOST-WIDE for every VM created while it is set, not only ours. That is why it is
# applied for the length of one probe and removed again in the same run, and why the default is to
# refuse to apply it at all.
#
#   .\isolated-probe.ps1 -Image C:\Users\claude\vbs-like\openhcl-x64-test-linux-direct.bin `
#                        -ImageSha256 d240f40c... [-Approve] [-TimeoutSeconds 180]
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string] $Image,
  [Parameter(Mandatory = $true)][string] $ImageSha256,
  [string] $Root = 'C:\Users\claude\vbs-like',
  [string] $EvidenceDir,
  [int]    $TimeoutSeconds = 180,
  # Without this, the script stops after the preflight. With it, the setting is applied for the
  # length of one probe and removed again before the script returns.
  [switch] $Approve
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$RegPath  = 'HKLM:\Software\Microsoft\Windows NT\CurrentVersion\Virtualization'
$RegName  = 'AllowFirmwareLoadFromFile'
$NodeTask = 'EnclaveWindowsNode'
if (-not $EvidenceDir) { $EvidenceDir = Join-Path $Root ("out\iso-probe-" + (Get-Date -Format 'yyyyMMdd-HHmmss')) }

$script:Findings = @()
function Note([string] $s) { Write-Host "  $s"; $script:Findings += $s }
function Fail([string] $s) { throw "PREFLIGHT FAILED: $s" }

# --- the setting's state, read and restored exactly -------------------------------------------------
# Absent and present-with-a-value are different states, and restoring the wrong one would leave the
# host changed by a script whose whole point is that it does not.
function Get-SettingState {
  $item = Get-ItemProperty -Path $RegPath -Name $RegName -ErrorAction SilentlyContinue
  if ($null -eq $item) { return [pscustomobject]@{ Present = $false; Value = $null; Kind = $null } }
  $kind = (Get-Item -Path $RegPath).GetValueKind($RegName)
  return [pscustomobject]@{ Present = $true; Value = $item.$RegName; Kind = "$kind" }
}
function Restore-SettingState($state) {
  if ($state.Present) {
    Set-ItemProperty -Path $RegPath -Name $RegName -Value $state.Value -Type $state.Kind
  } else {
    Remove-ItemProperty -Path $RegPath -Name $RegName -ErrorAction SilentlyContinue
  }
  $now = Get-SettingState
  $ok = ($now.Present -eq $state.Present) -and ($now.Value -eq $state.Value)
  return [pscustomobject]@{ Restored = $ok; Now = $now }
}

# --- the live node: healthy before, and still healthy after -----------------------------------------
function Get-NodeHealth {
  $task = Get-ScheduledTask -TaskName $NodeTask -ErrorAction SilentlyContinue
  $procs = @(Get-Process ee-host, node, shielded-worker -ErrorAction SilentlyContinue | Select-Object -ExpandProperty ProcessName)
  return [pscustomobject]@{ TaskState = if ($task) { "$($task.State)" } else { 'missing' }; Processes = ($procs | Sort-Object) }
}
function Test-NodeUnchanged($before, $after) {
  return ($before.TaskState -eq $after.TaskState) -and (($before.Processes -join ',') -eq ($after.Processes -join ','))
}

New-Item -ItemType Directory -Force -Path $EvidenceDir | Out-Null
$transcript = Join-Path $EvidenceDir 'transcript.txt'
Start-Transcript -Path $transcript | Out-Null

$applied = $false
$before  = $null
$nodeBefore = $null
try {
  Write-Host "=== preflight (nothing is changed in this phase)"

  # 1. elevation: without it the probe's own partition creation fails for the wrong reason
  $principal = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
  if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { Fail 'not elevated' }
  Note 'elevated: yes'

  # 2. the setting's current state, recorded before anything else
  $before = Get-SettingState
  $before | ConvertTo-Json | Set-Content (Join-Path $EvidenceDir 'setting-before.json')
  Note ("setting before: " + $(if ($before.Present) { "present, $($before.Kind) = $($before.Value)" } else { 'ABSENT' }))

  # 3. the live node, which this script must leave exactly as it found
  $nodeBefore = Get-NodeHealth
  $nodeBefore | ConvertTo-Json | Set-Content (Join-Path $EvidenceDir 'node-before.json')
  if ($nodeBefore.TaskState -ne 'Running') { Fail "the live node's task is $($nodeBefore.TaskState), not Running: refusing to touch a host whose node is already unhealthy" }
  Note ("live node: task Running, processes " + ($nodeBefore.Processes -join ' '))

  # 4. no lab partition may be live: the probe creates its own and must start from nothing
  $host_exe = Join-Path $Root 'target\release\vbslike-host.exe'
  if (-not (Test-Path $host_exe)) { Fail "launcher not built at $host_exe" }
  $probeJson = & $host_exe probe 2>&1 | Out-String
  $owned = ([regex]::Matches($probeJson, '"Owner"\s*:\s*"vbslike"')).Count
  if ($owned -ne 0) { Fail "$owned compute systems owned by vbslike already exist; destroy them first" }
  Note 'no lab partitions exist'

  # 5. the image: present, and EXACTLY the bytes whose provenance PHASE2.md records
  if (-not (Test-Path $Image)) { Fail "image not found: $Image" }
  $actual = (Get-FileHash -Algorithm SHA256 $Image).Hash.ToLower()
  if ($actual -ne $ImageSha256.ToLower()) { Fail "image sha256 is $actual, expected $ImageSha256" }
  Note "image sha256 verified: $actual"

  # 6. the VM worker account must be able to READ the image, or the probe fails for a reason that has
  #    nothing to do with the setting (measured earlier with the VMGS files: 0x80070005)
  $acl = (Get-Acl $Image).Access | Where-Object { $_.IdentityReference -like '*Virtual Machines*' -or $_.IdentityReference -eq 'NT VIRTUAL MACHINE\Virtual Machines' }
  if (-not $acl) { Fail "the VM worker account has no ACE on $Image; grant it read before approving (icacls <image> /grant *S-1-5-83-0:(R))" }
  Note 'image readable by the VM worker account'

  $before, $nodeBefore, $actual | Out-Null
  if (-not $Approve) {
    Write-Host "=== preflight complete, and NOTHING was changed."
    Write-Host "    Without -Approve this script stops here. With it, it would:"
    Write-Host "      1. set $RegName = 1 (REG_DWORD) under $RegPath  [HOST-WIDE, permits UNSIGNED guest firmware]"
    Write-Host "      2. run: vbslike-host isoprobe --only vbs-igvmpath --igvm $Image"
    Write-Host "      3. restore the setting to '$(if ($before.Present) { "$($before.Kind)=$($before.Value)" } else { 'absent' })' and verify the restoration"
    Write-Host "    Evidence: $EvidenceDir"
    return
  }

  # --- apply, probe, and restore ---------------------------------------------------------------
  Write-Host "=== applying the setting for the length of one probe"
  Set-ItemProperty -Path $RegPath -Name $RegName -Value 1 -Type DWORD
  $applied = $true
  (Get-SettingState) | ConvertTo-Json | Set-Content (Join-Path $EvidenceDir 'setting-applied.json')

  Write-Host "=== probe (creates and destroys its own partitions only)"
  $out = Join-Path $EvidenceDir 'isoprobe'
  $p = Start-Process -FilePath $host_exe -PassThru -NoNewWindow -RedirectStandardOutput (Join-Path $EvidenceDir 'isoprobe.out') `
        -RedirectStandardError (Join-Path $EvidenceDir 'isoprobe.err') `
        -ArgumentList @('isoprobe', '--only', 'vbs-igvmpath', '--kernel', (Join-Path $Root 'wsl-kernel'),
                        '--initrd', (Join-Path $Root 'mon.cpio.gz'), '--igvm', $Image, '--out', $out, '--seconds', '20')
  if (-not $p.WaitForExit($TimeoutSeconds * 1000)) {
    Write-Warning "the probe exceeded ${TimeoutSeconds}s; killing it so the setting can be restored"
    $p | Stop-Process -Force -ErrorAction SilentlyContinue
  }
  Note "probe exit code: $($p.ExitCode)"
}
finally {
  # Restoration runs on EVERY path: success, a failed preflight, a probe timeout, an unhandled error
  # or Ctrl-C. If the setting was never applied there is nothing to undo, and this still verifies it.
  Write-Host "=== restore"
  if ($null -ne $before) {
    $r = Restore-SettingState $before
    $r | ConvertTo-Json -Depth 4 | Set-Content (Join-Path $EvidenceDir 'setting-after.json')
    if ($r.Restored) {
      Write-Host ("  setting restored to " + $(if ($before.Present) { "$($before.Kind)=$($before.Value)" } else { 'ABSENT' }))
    } else {
      Write-Error "THE SETTING WAS NOT RESTORED. Expected $(if ($before.Present) { $before.Value } else { 'absent' }), found $($r.Now | ConvertTo-Json -Compress). Remove it by hand: Remove-ItemProperty '$RegPath' -Name $RegName"
    }
  } else {
    Write-Host '  nothing to restore: the run stopped before the setting was read'
  }

  # any partition the probe left behind, and only ones this lab owns
  try {
    if (Test-Path (Join-Path $Root 'target\release\vbslike-host.exe')) {
      $left = ([regex]::Matches((& (Join-Path $Root 'target\release\vbslike-host.exe') probe 2>&1 | Out-String), '"Owner"\s*:\s*"vbslike"')).Count
      Write-Host "  lab partitions left: $left"
      if ($left -ne 0) { Write-Warning "$left lab partitions remain; they are terminated by the probe normally, destroy them before the next run" }
    }
  } catch { Write-Warning "could not re-check lab partitions: $_" }

  # the live node, unchanged
  if ($null -ne $nodeBefore) {
    $nodeAfter = Get-NodeHealth
    $nodeAfter | ConvertTo-Json | Set-Content (Join-Path $EvidenceDir 'node-after.json')
    if (Test-NodeUnchanged $nodeBefore $nodeAfter) {
      Write-Host "  live node unchanged: task $($nodeAfter.TaskState), processes $($nodeAfter.Processes -join ' ')"
    } else {
      Write-Error "THE LIVE NODE CHANGED: before $($nodeBefore | ConvertTo-Json -Compress) after $($nodeAfter | ConvertTo-Json -Compress)"
    }
  }
  Write-Host "  evidence: $EvidenceDir"
  Stop-Transcript | Out-Null
}
