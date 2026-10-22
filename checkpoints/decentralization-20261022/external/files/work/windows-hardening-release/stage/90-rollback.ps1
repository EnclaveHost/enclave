# 90-rollback.ps1 - EXACT rollback of 20-activate.ps1 (root runs it; never automatic).
#   powershell -NoProfile -ExecutionPolicy Bypass -File <stage>\90-rollback.ps1
# The tool's journaled rollback: each file it wrote is restored from its verified backup, compare-and-swap (a file changed
# by anyone since is reported and NOT overwritten), then ONLY the node agent is restarted (the run-node.cmd loop starts
# the previous code with the same environment). If 20-activate.ps1 stopped and disabled the Node task (exit 4), it is
# enabled and started again after the files are back. Whatever the tool's exit, its own status must then show EVERY plan
# file as its previous version; otherwise nothing more is done (exit 1). Settings, manager, VMs and apps are not touched.
param([string]$Stage = $PSScriptRoot)
. (Join-Path $Stage 'common.ps1')
& $Node $Tool rollback --plan $Plan --observe-sec 180
$code = $LASTEXITCODE
Say "activate-control-source rollback exit $code (0 restored+observed, 3 restored+unobserved, 2 nothing applied, 1 conflict/error)"
if ($code -eq 1) { Say "NOT ROLLED BACK: conflict or error (see the tool status below); nothing else is done"; & $Node $Tool status --plan $Plan; exit 1 }
if (-not (AllState 'before')) { Say "NOT ROLLED BACK: not every plan file is its previous version (exit $code); nothing else is done"; exit 1 }
Say "every plan file is its previous version (tool status)"
$task = Get-ScheduledTask -TaskPath '\Enclave\' -TaskName 'Node' -ErrorAction SilentlyContinue
if ($task -and $task.State -eq 'Disabled') { Enable-ScheduledTask -TaskPath '\Enclave\' -TaskName 'Node' | Out-Null; Start-ScheduledTask -TaskPath '\Enclave\' -TaskName 'Node'; Say "the Node task was disabled by 20-activate.ps1: enabled and started" }
for ($i = 0; $i -lt 180 -and -not (@(AgentProcs).Count -eq 1 -and (Healthy)); $i++) { Start-Sleep 1 }
Say "ROLLED BACK: agents $((@(AgentProcs) | ForEach-Object { $_.ProcessId }) -join ','), healthy $(Healthy), lease mode '$((LeaseMode).leaseGas)'"
exit 0
