# 10-preflight.ps1 - READ-ONLY. Changes nothing, stops nothing. Public facts only:
#   the stage verifies; the installed closure is exactly the plan's (3 files "before", 77 unchanged, by hash); the
#   lease-gas settings from the previous activation are still the reviewed bytes and still called; ONE node agent and ONE
#   run-node.cmd loop run, healthy and app-funded; no earlier run of this plan; the Update task is not running; the VMs.
#   powershell -NoProfile -ExecutionPolicy Bypass -File <stage>\10-preflight.ps1
param([string]$Stage = $PSScriptRoot)
. (Join-Path $Stage 'common.ps1')
$ok = $true
function Check([bool]$c, [string]$m) { if ($c) { Say "ok   $m" } else { Say "FAIL $m"; $script:ok = $false } }
& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Stage '00-verify-stage.ps1') -Stage $Stage
Check ($LASTEXITCODE -eq 0) "the stage verifies against SHA256SUMS"
$plan = Get-Content -LiteralPath $Plan -Raw | ConvertFrom-Json
Check ($plan.id -eq $PlanId) "plan $PlanId"
$before = 0; $after = 0; $other = @(); $unch = @()
foreach ($e in @($plan.files)) { $h = Sha (Join-Path $Control ($e.path -replace '/', '\')); if ($h -eq $e.before) { $before++ } elseif ($h -eq $e.after) { $after++ } else { $other += $e.path } }
foreach ($e in @($plan.unchanged)) { if ((Sha (Join-Path $Control ($e.path -replace '/', '\'))) -ne $e.sha256) { $unch += $e.path } }
Say "  changed files: $before before, $after after, $(@($other).Count) other $($other -join ', ')"
Check ($before -eq @($plan.files).Count -and @($unch).Count -eq 0) "all $(@($plan.files).Count) changed files are their recorded before, all $(@($plan.unchanged).Count) unchanged files match ($(@($unch).Count) differ $($unch -join ', '))"
Check (SettingsOk) "the lease-gas settings are the reviewed bytes and still called (they are not touched by this release)"
Check (-not (Test-Path -LiteralPath $ToolState)) "no earlier run of this plan ($ToolState)"
$u = Get-ScheduledTask -TaskPath '\Enclave\' -TaskName 'Update' -ErrorAction SilentlyContinue
Check (-not $u -or $u.State -ne 'Running') "the Update task is not running"
$ag = @(AgentProcs); $lp = @(LoopProcs)
Check ($ag.Count -eq 1 -and $lp.Count -eq 1) "one node agent ($(($ag | ForEach-Object { $_.ProcessId }) -join ',')) and one run-node.cmd loop ($(($lp | ForEach-Object { $_.ProcessId }) -join ','))"
Check (Healthy) "the agent answers /v1/health"
$m = LeaseMode
Check ($m.leaseGas -eq 'app-funded') "lease mode $($m.leaseGas) (operator $($m.operator))"
Check (Test-Path -LiteralPath $Node -PathType Leaf) "$Node ($(& $Node --version))"
Say "  VMs: $((Vms | ForEach-Object { "$($_.id)=$($_.status)" }) -join ' ')"
foreach ($t in 'Node', 'Shield', 'Network', 'Update') { $x = Get-ScheduledTask -TaskPath '\Enclave\' -TaskName $t -ErrorAction SilentlyContinue; Say "  task \Enclave\$t : $(if ($x) { $x.State } else { 'absent' })" }
Say "== $(if ($ok) { 'PREFLIGHT OK' } else { 'PREFLIGHT FAILED: do not activate' })"
if ($ok) { exit 0 } else { exit 1 }
