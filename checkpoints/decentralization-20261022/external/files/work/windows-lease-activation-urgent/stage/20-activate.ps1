# 20-activate.ps1 - root runs this ONCE, only after both relays answer over https and every enrollment is confirmed.
#   powershell -NoProfile -ExecutionPolicy Bypass -File <stage>\20-activate.ps1 -RelaysChecked
# It is NOT re-runnable: any earlier run's state (this plan's tool journal or settings record) refuses it before anything
# is stopped. After an unknown outcome: 30-verify.ps1, then an explicit 90-rollback.ps1 (or reconcile by hand).
# Order (config first, so the new agent is started only with the settings in place):
#   0. gates, read-only: stage, run-node.cmd structure, no Update run, no earlier run state, the two lease-gas files
#      absent or exactly the reviewed bytes, no LEASE_GAS_ setting and no call line yet.
#   1. the \Enclave\Node task DISABLED and stopped (its run-node.cmd loop and the agent only; the Shield manager, its
#      VMs and the Network agent are not touched): no agent runs between the steps below, not even after a reboot.
#   2. a NEW private state directory (SYSTEM + Administrators only) holds the config target's previous bytes and a
#      create-only record of them; then the reviewed settings go to ProgramData\Enclave\lease-gas and ONE call line is
#      appended to the config target (in place: its ACL and its other bytes stay as they are).
#   3. the reviewed source: activate-control-source.mjs apply (hash preflight, journal, verified backups, CAS writes);
#      with no agent running it restarts nothing (exit 3).
#   4. the Node task enabled and started: a fresh run-node.cmd loads the settings and runs the new agent, whose
#      loopback /v1/host/state must report availability.leaseGas "app-funded".
# Exit: 0 activated, app-funded observed | 2 refused, nothing changed (Node as before) | 3 unobserved: 30-verify.ps1 |
#       4 the new agent reports operator-paid: Node stopped + disabled | 1 error: Node left DISABLED; 30-verify, 90-rollback.
param([string]$Stage = $PSScriptRoot, [switch]$RelaysChecked)
. (Join-Path $Stage 'common.ps1')
if (-not $RelaysChecked) { Say "refused: run with -RelaysChecked once both relays' https /v1/info name reserve 0x12A3f873041Dec436DaA0085B766a399A6fA3639 and every enrollment is confirmed"; exit 2 }

# ---- 0. gates (read-only; a refusal here changes nothing)
& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Stage '00-verify-stage.ps1') -Stage $Stage
if ($LASTEXITCODE -ne 0) { Say "refused: the stage does not verify"; exit 2 }
$rn = @(Get-Content -LiteralPath $RunNode)
$callAt = [array]::IndexOf(@($rn | ForEach-Object { $_ -match ('^\s*call\s+"' + [regex]::Escape($NodeCfg) + '"') }), $true)
$loopAt = [array]::IndexOf(@($rn | ForEach-Object { $_ -match '^:loop' }), $true)
if (-not ($callAt -ge 0 -and $loopAt -gt $callAt)) { Say "refused: $RunNode is not the expected call-then-loop script"; exit 2 }
$u = Get-ScheduledTask -TaskPath '\Enclave\' -TaskName 'Update' -ErrorAction SilentlyContinue
if ($u -and $u.State -eq 'Running') { Say "refused: the Update task is running; retry when it is done"; exit 2 }
if (Test-Path -LiteralPath $CfgState) { Say "refused: $CfgState exists (an earlier run). Inspect with 30-verify.ps1; undo with 90-rollback.ps1 - this script never re-runs over it"; exit 2 }
if (Test-Path -LiteralPath $ToolState) { Say "refused: $ToolState exists (an earlier apply of this plan). Inspect with 30-verify.ps1; undo with 90-rollback.ps1"; exit 2 }
$leasePrev = @{}
foreach ($f in $Want.Keys) {
  $h = Sha (Join-Path $LeaseDir $f); $leasePrev[$f] = $h
  if ($h -and $h -ne $Want[$f]) { Say "refused: $(Join-Path $LeaseDir $f) exists with other bytes ($h); this first deployment never overwrites it"; exit 2 }
}
$target = ConfigTarget
if (HasLine $target $CallLine) { Say "refused: $target already calls the lease-gas settings (an earlier, unrecorded change): reconcile by hand"; exit 2 }
if ((SetsLeaseGas $NodeCfg) -or (SetsLeaseGas $NodeLocal)) { Say "refused: a LEASE_GAS_ setting already exists in the node configuration; resolve by hand"; exit 2 }
$vmsBefore = Vms
Say "VMs before: $(($vmsBefore | ForEach-Object { "$($_.id)=$($_.status)" }) -join ' ')"

function KeepStopped([string]$why) { Say "$why - the Node task stays DISABLED and stopped; run 30-verify.ps1, then 90-rollback.ps1"; exit 1 }
function StartNode { Enable-ScheduledTask -TaskPath '\Enclave\' -TaskName 'Node' | Out-Null; Start-ScheduledTask -TaskPath '\Enclave\' -TaskName 'Node' }
function UndoConfig([string]$why) {
  Say "undoing the settings step: $why"
  & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Stage '90-rollback.ps1') -Stage $Stage -ConfigOnly
  return ($LASTEXITCODE -eq 0)
}

# ---- 1. the node agent only: disable + stop its task; neither the loop nor the agent may be left
Disable-ScheduledTask -TaskPath '\Enclave\' -TaskName 'Node' | Out-Null
Stop-ScheduledTask -TaskPath '\Enclave\' -TaskName 'Node' -ErrorAction SilentlyContinue
for ($i = 0; $i -lt 30 -and ((LoopProcs).Count -or (AgentProcs).Count); $i++) { Start-Sleep 1 }
foreach ($p in (LoopProcs)) { Say "stopping run-node.cmd loop pid $($p.ProcessId)"; Stop-Process -Id $p.ProcessId -Force }
foreach ($p in (AgentProcs)) { Say "stopping node agent pid $($p.ProcessId)"; Stop-Process -Id $p.ProcessId -Force }
Start-Sleep 2
if ((LoopProcs).Count -or (AgentProcs).Count) { Say "error: the node agent could not be stopped; nothing was changed. Re-enabling and starting the Node task."; StartNode; exit 1 }
Say "node agent stopped; Node task disabled"

# ---- 2. private record of the previous bytes, then the settings and the call line
try {
  New-Item -ItemType Directory -Force -Path $ActState | Out-Null
  NewPrivateDir $CfgState                                   # SYSTEM + Administrators only, before any data goes in
  $existed = Test-Path -LiteralPath $target -PathType Leaf
  $beforeHash = Sha $target
  if ($existed) {
    [IO.File]::Copy($target, (Join-Path $CfgState 'config-target.before'), $false)   # create-only
    if ((Sha (Join-Path $CfgState 'config-target.before')) -ne $beforeHash) { throw "the kept copy of $target does not verify" }
  }
  WriteNew (Join-Path $CfgState 'config.json') ([ordered]@{ plan = $PlanId; target = $target; existed = $existed; beforeHash = $beforeHash; callLine = $CallLine
    leaseDirExisted = (Test-Path -LiteralPath $LeaseDir); leaseFilesBefore = $leasePrev; at = [DateTime]::UtcNow.ToString('o') } | ConvertTo-Json)
  New-Item -ItemType Directory -Force -Path $LeaseDir | Out-Null
  foreach ($f in $Want.Keys) {
    $dst = Join-Path $LeaseDir $f
    if ((Sha $dst) -eq $Want[$f]) { continue }
    if (Test-Path -LiteralPath $dst) { throw "$dst appeared with other bytes" }
    [IO.File]::Copy((Join-Path $Stage "lease-gas\$f"), "$dst.activate-tmp", $false)
    if ((Sha "$dst.activate-tmp") -ne $Want[$f]) { throw "$f did not copy intact" }
    Move-Item -LiteralPath "$dst.activate-tmp" -Destination $dst
    if ((Sha $dst) -ne $Want[$f]) { throw "$dst does not verify" }
  }
  if ($existed) { Add-Content -LiteralPath $target -Encoding ASCII -Value @('', 'rem app-funded lease gas (reviewed public settings; no keys)', $CallLine) }
  else { Set-Content -LiteralPath $target -Encoding ASCII -Value @('@echo off', "rem This box's own node settings, read after node-config.cmd. Updates never write this file.",
                                                                   'rem app-funded lease gas (reviewed public settings; no keys)', $CallLine) }
  if (-not (HasLine $target $CallLine)) { throw "the call line is not in $target" }
  WriteNew (Join-Path $CfgState 'config.after.json') ([ordered]@{ plan = $PlanId; target = $target; afterHash = (Sha $target); at = [DateTime]::UtcNow.ToString('o') } | ConvertTo-Json)
  Say "settings installed ($LeaseDir) and called from $target"
} catch {
  $why = $_.Exception.Message
  if ((Test-Path -LiteralPath (Join-Path $CfgState 'config.json')) -and -not (UndoConfig $why)) { KeepStopped "the settings step failed ($why) and could not be undone" }
  if (Test-Path -LiteralPath (Join-Path $CfgState 'config.json')) { KeepStopped "the settings step failed ($why); its record remains" }
  StartNode; Say "refused: $why (nothing else changed; Node restarted as it was)"; exit 2
}

# ---- 3. the reviewed source (the existing tool; nothing to restart while the agent is stopped)
& $Node $Tool apply --plan $Plan --source $Source --accept-manager-shared --observe-sec 5
$code = $LASTEXITCODE
Say "activate-control-source apply exit $code (3 expected: applied, no agent running to restart)"
if ($code -eq 2) {
  if (-not (AllBefore)) { KeepStopped "the tool refused but the control files are not all their previous versions" }
  if (-not (UndoConfig "the tool refused (control unchanged)")) { KeepStopped "the settings could not be undone" }
  StartNode; Say "refused by the tool; settings undone; Node restarted on the previous code and settings"; exit 2
}
if ($code -ne 0 -and $code -ne 3) { KeepStopped "the tool reported an error (exit $code)" }
if (@((ToolStatus).files | Where-Object { $_.state -ne 'after' }).Count) { KeepStopped "after apply, not every plan file is its reviewed version" }

# ---- 4. a fresh run-node.cmd: the settings and the new agent together
StartNode
Say "Node task enabled and started"
$mode = $null
for ($i = 0; $i -lt 180; $i++) {
  Start-Sleep 1
  if ((AgentProcs).Count -ne 1) { continue }
  try { $h = (Invoke-RestMethod -TimeoutSec 3 'http://127.0.0.1:9600/v1/health').ok } catch { $h = $false }
  if (-not $h) { continue }
  $mode = (LeaseMode).leaseGas
  if ($mode) { break }
}
$vmsAfter = Vms
$lost = @(foreach ($v in @($vmsBefore)) { if ($v -and $v.status -eq 'running' -and -not (@($vmsAfter) | Where-Object { $_ -and $_.id -eq $v.id -and $_.status -eq 'running' })) { $v.id } })
Say "VMs after: $(($vmsAfter | ForEach-Object { "$($_.id)=$($_.status)" }) -join ' ')$(if ($lost.Count) { "  ** no longer running: $($lost -join ', ')" } else { '  (every VM running before still runs)' })"
if ($mode -eq 'operator-paid') {
  Stop-ScheduledTask -TaskPath '\Enclave\' -TaskName 'Node' -ErrorAction SilentlyContinue
  foreach ($p in (LoopProcs)) { Stop-Process -Id $p.ProcessId -Force }; foreach ($p in (AgentProcs)) { Stop-Process -Id $p.ProcessId -Force }
  Disable-ScheduledTask -TaskPath '\Enclave\' -TaskName 'Node' | Out-Null
  Say "STOPPED: the new agent reports operator-paid (the settings did not load); the Node task is disabled. Check node.log for operator-paid lease sends since the start; then 90-rollback.ps1"; exit 4
}
if ($mode -ne 'app-funded') { Say "UNOBSERVED within 180 s (lease mode '$mode'): run 30-verify.ps1"; exit 3 }
Say "ACTIVATED: new agent pid $((AgentProcs)[0].ProcessId) healthy, leaseGas app-funded; operator $((LeaseMode).operator)"
& $Node $Tool status --plan $Plan
exit 0
