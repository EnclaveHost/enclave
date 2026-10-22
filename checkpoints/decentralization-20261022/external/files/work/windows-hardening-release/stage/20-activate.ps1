# 20-activate.ps1 - root runs this ONCE after reviewing 10-preflight.ps1's output.
#   powershell -NoProfile -ExecutionPolicy Bypass -File <stage>\20-activate.ps1 -Reviewed
# SOURCE ONLY: three files (sdk/bootstrap/package.mjs, windows/node/host.mjs, windows/node/lease-gas-runtime.bundle.mjs).
# The lease-gas settings, the Shield/VM manager, the Network agent, the release journal and every app stay as they are.
#   0. gates, read-only (a refusal changes nothing): stage, plan files all "before", unchanged files match, settings
#      reviewed and called, one agent + one loop, healthy, app-funded, no earlier run of this plan, Update not running.
#   1. activate-control-source.mjs apply (hash preflight, write-ahead journal, verified backups, compare-and-swap writes),
#      then it ends ONLY the node agent process: its run-node.cmd loop starts the new code ~10 s later with the SAME
#      environment (the lease-gas settings loaded when that loop started). No manager-shared file is in this plan.
#   2. observed here: the plan's files all "after", ONE new agent answering /v1/health, lease mode app-funded, the VMs
#      that ran before still running.
# Exit: 0 applied and observed app-funded | 2 refused, nothing changed | 3 applied, not observed (30-verify.ps1) |
#       4 the new agent is not app-funded: the Node task is stopped and disabled (90-rollback.ps1) | 1 error (30-verify).
# It never re-runs over an earlier run of the same plan: after an unknown outcome use 30-verify.ps1, then 90-rollback.ps1.
param([string]$Stage = $PSScriptRoot, [switch]$Reviewed)
. (Join-Path $Stage 'common.ps1')
if (-not $Reviewed) { Say "refused: run with -Reviewed after reviewing 10-preflight.ps1's output"; exit 2 }
& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Stage '10-preflight.ps1') -Stage $Stage
if ($LASTEXITCODE -ne 0) { Say "refused: the preflight did not pass; nothing was changed"; exit 2 }
$vmsBefore = @(Vms)
$oldPid = @(AgentProcs)[0].ProcessId
Say "agent pid before: $oldPid; VMs before: $(($vmsBefore | ForEach-Object { "$($_.id)=$($_.status)" }) -join ' ')"

& $Node $Tool apply --plan $Plan --source $Source --observe-sec 180
$code = $LASTEXITCODE
Say "activate-control-source apply exit $code (0 applied+observed, 3 applied+unobserved, 2 refused, 1 error)"
if ($code -eq 2) { if (AllState 'before') { Say "refused by the tool; nothing was changed"; exit 2 } else { Say "error: the tool refused but the files are not all their previous versions: 30-verify.ps1, then 90-rollback.ps1"; exit 1 } }
if ($code -ne 0 -and $code -ne 3) { Say "error (exit $code): 30-verify.ps1, then 90-rollback.ps1"; exit 1 }
if (-not (AllState 'after')) { Say "error: after apply, not every plan file is its reviewed version: 30-verify.ps1, then 90-rollback.ps1"; exit 1 }

$mode = $null; $newPid = $null
for ($i = 0; $i -lt 180; $i++) {
  $ag = @(AgentProcs)
  if ($ag.Count -eq 1 -and $ag[0].ProcessId -ne $oldPid -and (Healthy)) { $newPid = $ag[0].ProcessId; $mode = (LeaseMode).leaseGas; if ($mode) { break } }
  Start-Sleep 1
}
$vmsAfter = @(Vms)
$lost = @(foreach ($v in $vmsBefore) { if ($v -and $v.status -eq 'running' -and -not ($vmsAfter | Where-Object { $_ -and $_.id -eq $v.id -and $_.status -eq 'running' })) { $v.id } })
Say "VMs after: $(($vmsAfter | ForEach-Object { "$($_.id)=$($_.status)" }) -join ' ')$(if ($lost.Count) { "  ** no longer running: $($lost -join ', ')" } else { '  (every VM running before still runs)' })"
if ($mode -eq 'operator-paid') {
  Stop-ScheduledTask -TaskPath '\Enclave\' -TaskName 'Node' -ErrorAction SilentlyContinue
  foreach ($p in @(LoopProcs)) { Stop-Process -Id $p.ProcessId -Force }; foreach ($p in @(AgentProcs)) { Stop-Process -Id $p.ProcessId -Force }
  Disable-ScheduledTask -TaskPath '\Enclave\' -TaskName 'Node' | Out-Null
  Say "STOPPED: the new agent reports operator-paid; the Node task is disabled. Check node.log, then 90-rollback.ps1"; exit 4
}
if ($mode -ne 'app-funded') { Say "UNOBSERVED within 180 s (agent pid '$newPid', lease mode '$mode'): run 30-verify.ps1"; exit 3 }
Say "ACTIVATED: new agent pid $newPid (was $oldPid) healthy, leaseGas app-funded; operator $((LeaseMode).operator)"
exit 0
