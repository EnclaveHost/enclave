# 20-apply-control.ps1 - the 4-file windows/node delta (app-zone Shield host sessions) by the activation tool: preflight of all
# 79 other files, journal, verified backups, compare-and-swap writes; only the node agent is ended (its run-node.cmd loop
# restarts it ~10 s later); the manager and its VMs keep running. Exit: the tool's (0 applied+observed, 3 applied-unobserved,
# 2 refused before any change, 1 error -> 90-rollback.ps1).
param([Parameter(Mandatory = $true)][string]$Stage, [switch]$Reviewed)
. (Join-Path $Stage 'common.ps1')
if (-not $Reviewed) { Say "refused: run with -Reviewed after 10-preflight.ps1 printed PREFLIGHT OK"; exit 2 }
$vmsBefore = Vms
& $Node $Tool apply --plan $Plan --source $Source --observe-sec 120
$code = $LASTEXITCODE
$vmsAfter = Vms
Say "activate-control-source apply exit $code; VMs before $(@($vmsBefore).Count), after $(@($vmsAfter).Count)"
exit $code
