# 20-activate.ps1 - root runs this ONCE, after 15-install-relay.ps1 serves the moved key and 10-preflight.ps1 -AfterRelay passed.
#   powershell -NoProfile -ExecutionPolicy Bypass -File <stage>\20-activate.ps1 -Reviewed
# It points the node agent at its OWN relay: ONE control file (windows/node/lease-gas-runtime.bundle.mjs d2e363c5, the
# bundle that knows LOCAL_RELAY; 79 files unchanged, no manager-shared file) and ONE settings file (lease-gas-config.cmd
# 9ed3c199 -> 2324904b: + LOCAL_RELAY=http://127.0.0.1:8549, RELAYS = eu-central only). The run-node.cmd loop reads the
# settings only when it starts, so the Node TASK is restarted (the VMs keep running in the manager; the agent re-adopts them):
#   0. gates, read-only (a refusal changes nothing): 10-preflight.ps1 -AfterRelay; the source origin does not answer as the
#      moved payee; no earlier run of this plan.
#   1. the current settings are backed up (verified copy) in control-activation\<plan>-config;
#   2. the Node task, its run-node.cmd loop and the agent are stopped (VMs untouched);
#   3. activate-control-source.mjs apply (hash preflight, journal, verified backup, compare-and-swap write; no agent runs,
#      so it restarts nothing);
#   4. the settings are swapped compare-and-swap (exactly 9ed3c199 -> exactly 2324904b, atomic rename);
#   5. the Node task is started; observed: ONE new agent healthy, app-funded, its loop started after the swap, every VM that
#      ran before still running, the local relay still the moved key.
# A failure in 2-4 restores what was changed (tool rollback, settings back) and starts the Node task again.
# Exit: 0 activated | 2 refused, nothing changed | 3 activated, not observed (30-verify.ps1) | 4 operator-paid: Node stopped
#       and disabled (90-rollback.ps1) | 1 error (30-verify.ps1, then 90-rollback.ps1).
param([string]$Stage = $PSScriptRoot, [switch]$Reviewed)
. (Join-Path $Stage 'common.ps1')
if (-not $Reviewed) { Say "refused: run with -Reviewed after reviewing 10-preflight.ps1 -AfterRelay's output"; exit 2 }
& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Stage '10-preflight.ps1') -Stage $Stage -AfterRelay
if ($LASTEXITCODE -ne 0) { Say "refused: the preflight did not pass; nothing was changed"; exit 2 }
$probe = (& $Node -e "fetch(process.argv[1]+'/v1/info',{signal:AbortSignal.timeout(8000)}).then(r=>r.ok?r.json():null).then(j=>console.log(j&&String(j.payee||'').toLowerCase()===process.argv[2].toLowerCase()?'SERVING':'not-serving')).catch(e=>console.log(/CERT|TLS|SSL/i.test(String(e.cause&&e.cause.code||''))?'unknown':'not-serving'))" $SourceOrigin $Payee | Out-String).Trim()
if ($probe -ne 'not-serving') { Say "refused: the source relay $SourceOrigin answers '$probe' for the moved payee; nothing was changed"; exit 2 }
if (Test-Path -LiteralPath $CfgState) { Say "refused: $CfgState exists (an earlier run): 30-verify.ps1, then 90-rollback.ps1"; exit 2 }
New-Item -ItemType Directory -Path $CfgState | Out-Null
$backup = Join-Path $CfgState 'lease-gas-config.cmd.before'
Copy-Item -LiteralPath $LeaseCmd -Destination $backup
if ((Sha $backup) -ne $CfgBefore) { Say "error: the settings backup is not $CfgBefore; nothing else was changed"; exit 1 }
$vmsBefore = @(Vms); $oldPid = @(AgentProcs)[0].ProcessId
Say "agent pid before: $oldPid; VMs before: $(($vmsBefore | ForEach-Object { "$($_.id)=$($_.status)" }) -join ' ')"

if (-not (StopNode)) { Say "error: the node agent could not be stopped; nothing was changed. Starting the Node task again."; StartNode; exit 1 }
Say "the Node task, its loop and the agent are stopped"
& $Node $Tool apply --plan $Plan --source $Source --observe-sec 5
$code = $LASTEXITCODE
Say "activate-control-source apply exit $code (no agent runs now: 3 = applied, nothing restarted)"
if ($code -eq 2 -and (AllState 'before')) { StartNode; Say "refused by the tool; nothing was changed; Node started again"; exit 2 }
if (($code -ne 0 -and $code -ne 3) -or -not (AllState 'after')) {
  & $Node $Tool rollback --plan $Plan --observe-sec 5 | Out-Null
  StartNode; Say "error: the bundle was not applied cleanly (exit $code); the tool rolled back what it wrote; Node started again: 30-verify.ps1"; exit 1
}
try { SwapCfg $CfgBefore $NewCfg $CfgAfter; $swapAt = Get-Date; Say "lease-gas-config.cmd: $CfgBefore -> $CfgAfter (LOCAL_RELAY $RelayUrl, then $Fallback)" }
catch {
  Say "error: the settings swap failed ($($_.Exception.Message)); rolling the bundle back"
  & $Node $Tool rollback --plan $Plan --observe-sec 5 | Out-Null
  StartNode; Say "Node started again with the previous bundle and settings: 30-verify.ps1"; exit 1
}
StartNode
$mode = $null; $newPid = $null
for ($i = 0; $i -lt 180; $i++) {
  Start-Sleep 1
  $ag = @(AgentProcs); $lp = @(LoopProcs)
  if ($ag.Count -eq 1 -and $lp.Count -eq 1 -and $ag[0].ProcessId -ne $oldPid -and (Healthy)) {
    $newPid = $ag[0].ProcessId; $mode = (LeaseMode).leaseGas
    $loopStarted = [datetime]$lp[0].CreationDate   # Get-CimInstance returns a DateTime
    if ($mode -and $loopStarted -gt $swapAt) { break }
  }
}
$vmsAfter = @(Vms)
$lost = @(foreach ($v in $vmsBefore) { if ($v -and $v.status -eq 'running' -and -not ($vmsAfter | Where-Object { $_ -and $_.id -eq $v.id -and $_.status -eq 'running' })) { $v.id } })
Say "VMs after: $(($vmsAfter | ForEach-Object { "$($_.id)=$($_.status)" }) -join ' ')$(if ($lost.Count) { "  ** no longer running: $($lost -join ', ')" } else { '  (every VM running before still runs)' })"
if ($mode -eq 'operator-paid') {
  StopNode | Out-Null; Disable-ScheduledTask -TaskPath '\Enclave\' -TaskName 'Node' | Out-Null
  Say "STOPPED: the new agent reports operator-paid; the Node task is disabled. Check node.log, then 90-rollback.ps1"; exit 4
}
if ($mode -ne 'app-funded' -or -not (RelayIsTheMovedKey)) { Say "UNOBSERVED within 180 s (agent '$newPid', lease mode '$mode', local relay the moved key: $(RelayIsTheMovedKey)): 30-verify.ps1"; exit 3 }
Say "ACTIVATED: agent $newPid (was $oldPid) healthy, app-funded, its loop started after the settings swap; lease operations go to $RelayUrl (the moved key $Payee) first, $Fallback as the alternate"
exit 0
