# 90-rollback.ps1 - EXACT rollback of 20-activate.ps1 (root runs it; never automatic). The relay is NOT touched here: the
# node simply stops naming it (95-rollback-relay.ps1 removes it from service; root moves the key back only after that).
#   powershell -NoProfile -ExecutionPolicy Bypass -File <stage>\90-rollback.ps1
#   1. the Node task, loop and agent are stopped;
#   2. the tool's journaled compare-and-swap restore of the bundle (a file changed by anyone since is reported, not
#      overwritten);
#   3. the settings: exactly 2324904b -> exactly the verified backup 9ed3c199 (left alone when already 9ed3c199; a third
#      state is reported and NOT overwritten);
#   4. the Node task is enabled and started; observed healthy.
# Exit 0 rolled back and observed | 3 rolled back, not observed | 1 conflict/error (nothing more is done after a conflict).
param([string]$Stage = $PSScriptRoot)
. (Join-Path $Stage 'common.ps1')
if (-not (StopNode)) { Say "NOT ROLLED BACK: the node agent could not be stopped"; exit 1 }
& $Node $Tool rollback --plan $Plan --observe-sec 5
$code = $LASTEXITCODE
Say "activate-control-source rollback exit $code (0/3 restored, 2 nothing applied, 1 conflict/error)"
if ($code -eq 1 -or -not (AllState 'before')) { Say "NOT ROLLED BACK: the bundle is not its previous version (exit $code); the Node task is left stopped"; & $Node $Tool status --plan $Plan; exit 1 }
$backup = Join-Path $CfgState 'lease-gas-config.cmd.before'
switch (CfgState) {
  'after'  { if ((Sha $backup) -ne $CfgBefore) { Say "NOT ROLLED BACK: the settings backup is missing or not $CfgBefore; the Node task is left stopped"; exit 1 }
             SwapCfg $CfgAfter $backup $CfgBefore; Say "lease-gas-config.cmd restored to $CfgBefore" }
  'before' { Say "lease-gas-config.cmd is already $CfgBefore" }
  default  { Say "NOT ROLLED BACK: lease-gas-config.cmd is $(Sha $LeaseCmd), neither the reviewed before nor after; it is NOT overwritten; the Node task is left stopped"; exit 1 }
}
StartNode
for ($i = 0; $i -lt 180 -and -not (@(AgentProcs).Count -eq 1 -and (Healthy)); $i++) { Start-Sleep 1 }
$ok = (@(AgentProcs).Count -eq 1) -and (Healthy) -and ((LeaseMode).leaseGas -eq 'app-funded')
Say "$(if ($ok) { 'ROLLED BACK' } else { 'ROLLED BACK, NOT OBSERVED' }): agents $((@(AgentProcs) | ForEach-Object { $_.ProcessId }) -join ','), healthy $(Healthy), lease mode '$((LeaseMode).leaseGas)'; settings $(CfgState)"
if ($ok) { exit 0 } else { exit 3 }
