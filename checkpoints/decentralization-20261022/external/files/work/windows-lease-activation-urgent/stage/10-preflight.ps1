# 10-preflight.ps1 - READ-ONLY. Changes nothing, stops nothing. Prints public facts only:
#   * the installed run-node.cmd (a public script install-host.ps1 writes): its config call and its loop, and that the
#     config is called ONCE, BEFORE the loop - so killing only the agent keeps the old environment;
#   * yes/no answers about the node configuration files (never their content): which file gets the call line, whether
#     it is already there, whether anything already sets a LEASE_GAS_ value;
#   * the activation tool's own status for the plan (file states before/after, agent pid and health, VMs);
#   * the closure against the plan (counts), the scheduled tasks, the current lease mode, the lease-gas directory.
#   powershell -NoProfile -ExecutionPolicy Bypass -File <stage>\10-preflight.ps1
param([string]$Stage = $PSScriptRoot)
. (Join-Path $Stage 'common.ps1')
$ok = $true
function Check([bool]$c, [string]$m) { if ($c) { Say "ok   $m" } else { Say "FAIL $m"; $script:ok = $false } }

Say "== startup (public run-node.cmd at $RunNode, sha256 $(Sha $RunNode))"
$rn = @(Get-Content -LiteralPath $RunNode)
$rn | Where-Object { $_ -match '^\s*call |^:loop|agent\.mjs|^goto ' } | ForEach-Object { Say "  run-node.cmd: $_" }
$callAt = [array]::IndexOf(($rn | ForEach-Object { $_ -match ('^\s*call\s+"' + [regex]::Escape($NodeCfg) + '"') }), $true)
$loopAt = [array]::IndexOf(($rn | ForEach-Object { $_ -match '^:loop' }), $true)
Check ($callAt -ge 0 -and $loopAt -gt $callAt) "run-node.cmd calls $NodeCfg once, before its :loop (new settings need a fresh run-node.cmd: the Node task restarts, not only the agent)"
Check ([bool]($rn | Where-Object { $_ -like ('*' + $Agent + '*') })) "run-node.cmd runs $Agent"
Check (Test-Path -LiteralPath $NodeCfg -PathType Leaf) "$NodeCfg exists"
$target = ConfigTarget
Say "  node-config.cmd calls node-config.local.cmd: $(HasLine $NodeCfg $LocalCall)"
Say "  the call line goes into: $target (exists: $(Test-Path -LiteralPath $target -PathType Leaf))"
Say "  call line already present: $(HasLine $target $CallLine)"
Say "  a LEASE_GAS_ value already set in node-config.cmd: $(SetsLeaseGas $NodeCfg); in node-config.local.cmd: $(SetsLeaseGas $NodeLocal)"
Check (-not ((SetsLeaseGas $NodeCfg) -or (SetsLeaseGas $NodeLocal))) "no LEASE_GAS_ setting exists yet (the reviewed file is the only source; called last, it would win anyway)"

Say "== lease-gas config directory $LeaseDir (exists: $(Test-Path -LiteralPath $LeaseDir))"
foreach ($f in $Want.Keys) {
  $h = Sha (Join-Path $LeaseDir $f)
  Say "  $f installed sha256: $h (reviewed $($Want[$f]); staged $(Sha (Join-Path $Stage "lease-gas\$f")))"
  Check (-not $h -or $h -eq $Want[$f]) "$f is absent or exactly the reviewed bytes (foreign bytes are never overwritten)"
}
Check (-not (HasLine $target $CallLine)) "the call line is not present yet"
Check (-not (Test-Path -LiteralPath $CfgState)) "no earlier settings record ($CfgState)"
Check (-not (Test-Path -LiteralPath $ToolState)) "no earlier apply of this plan ($ToolState)"

Say "== closure against the plan"
$plan = Get-Content -LiteralPath $Plan -Raw | ConvertFrom-Json
$before = 0; $after = 0; $other = @(); $unch = @()
foreach ($e in $plan.files) { $h = Sha (Join-Path $Control ($e.path -replace '/', '\')); if ($h -eq $e.before) { $before++ } elseif ($h -eq $e.after) { $after++ } else { $other += $e.path } }
foreach ($e in $plan.unchanged) { if ((Sha (Join-Path $Control ($e.path -replace '/', '\'))) -ne $e.sha256) { $unch += $e.path } }
Say "  changed files: $before before, $after after, $($other.Count) other $($other -join ', ')"
Check ($other.Count -eq 0 -and $unch.Count -eq 0) "every plan file is its before or after; every unchanged file is its recorded hash ($($unch.Count) differ $($unch -join ', '))"

Say "== processes, tasks, lease mode"
Check (Test-Path -LiteralPath $Node -PathType Leaf) "$Node exists ($(& $Node --version))"
Say "  agent processes: $((AgentProcs | ForEach-Object { $_.ProcessId }) -join ',')   run-node.cmd loops: $((LoopProcs | ForEach-Object { $_.ProcessId }) -join ',')"
foreach ($t in 'Node', 'Shield', 'Network', 'Update') { $x = Get-ScheduledTask -TaskPath '\Enclave\' -TaskName $t -ErrorAction SilentlyContinue; Say "  task \Enclave\$t : $(if ($x) { $x.State } else { 'absent' })" }
$u = Get-ScheduledTask -TaskPath '\Enclave\' -TaskName 'Update' -ErrorAction SilentlyContinue
Check (-not $u -or $u.State -ne 'Running') "the Update task is not running"
$m = LeaseMode; Say "  current lease mode: $($m.leaseGas) (operator $($m.operator))$(if ($m.error) { " - $($m.error)" })"
Say "  VMs: $((Vms | ForEach-Object { "$($_.id)=$($_.status)" }) -join ' ')"

Say "== activation tool status (read-only)"
& $Node $Tool status --plan $Plan
Say "== $(if ($ok) { 'PREFLIGHT OK' } else { 'PREFLIGHT FAILED: do not activate' })"
if ($ok) { exit 0 } else { exit 1 }
