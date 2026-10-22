# 10-preflight.ps1 - READ-ONLY. Changes nothing, stops nothing. Run BEFORE root stops the source relay, and again any time.
#   powershell -NoProfile -ExecutionPolicy Bypass -File <stage>\10-preflight.ps1
# Public facts only:
#   - the stage verifies;
#   - the installed control closure is the plan's baseline (1 file "before", 79 unchanged, by hash: a FRESH read of this
#     host, the compare-and-swap baseline);
#   - the lease-gas settings are the previous activation's reviewed bytes and are called;
#   - the staged settings load in the STAGED bundle as exactly local-first (127.0.0.1:8549) + eu-central, and in the
#     INSTALLED bundle as eu-central only (so any order, and either rollback, is safe);
#   - ONE node agent + ONE run-node.cmd loop, healthy, app-funded; the Update task is not running; no earlier run;
#   - the relay is not here yet (no \Enclave\Relay task, no relay process, nothing listening on 8549, no key or send record);
#   - the source relay at its DigitalOcean origin still answers as the funded payee (it is the live one until root stops it);
#   - the VMs and tasks.
param([string]$Stage = $PSScriptRoot, [switch]$AfterRelay)
. (Join-Path $Stage 'common.ps1')
$ok = $true
function Check([bool]$c, [string]$m) { if ($c) { Say "ok   $m" } else { Say "FAIL $m"; $script:ok = $false } }
& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Stage '00-verify-stage.ps1') -Stage $Stage
Check ($LASTEXITCODE -eq 0) "the stage verifies against SHA256SUMS"
$planObj = Get-Content -LiteralPath $Plan -Raw | ConvertFrom-Json
Check ($planObj.id -eq $PlanId) "plan $PlanId"
$nBefore = 0; $nAfter = 0; $other = @(); $unch = @()
foreach ($e in @($planObj.files)) { $h = Sha (Join-Path $Control ($e.path -replace '/', '\')); if ($h -eq $e.before) { $nBefore++ } elseif ($h -eq $e.after) { $nAfter++ } else { $other += $e.path } }
foreach ($e in @($planObj.unchanged)) { if ((Sha (Join-Path $Control ($e.path -replace '/', '\'))) -ne $e.sha256) { $unch += $e.path } }
Say "  changed files: $nBefore before, $nAfter after, $(@($other).Count) other $($other -join ', ')"
Check ($nBefore -eq @($planObj.files).Count -and @($unch).Count -eq 0) "all $(@($planObj.files).Count) changed file(s) are the recorded before, all $(@($planObj.unchanged).Count) unchanged files match ($(@($unch).Count) differ $($unch -join ', '))"
Check (@($planObj.managerShared).Count -eq 0) "no manager-shared file in the plan"
Check ((Sha $LeaseDep) -eq $DepSha) "deployment.json is the reviewed record ($DepSha)"
Check ((CfgState) -eq 'before') "lease-gas-config.cmd is the previous activation's reviewed bytes ($CfgBefore)"
Check (SettingsCalled) "the node configuration calls lease-gas-config.cmd"
$c1 = CfgCheck $NewBundle $NewCfg $RelayUrl $Fallback
Check $c1.ok "the staged settings load in the STAGED bundle as local $RelayUrl first, then $Fallback  ($($c1.out))"
$installedBundle = Join-Path $Control 'windows\node\lease-gas-runtime.bundle.mjs'
$c2 = CfgCheck $installedBundle $NewCfg 'none' $Fallback
Check $c2.ok "the staged settings load in the INSTALLED bundle as $Fallback only (LOCAL_RELAY ignored)  ($($c2.out))"
$c3 = CfgCheck $NewBundle $LeaseCmd 'none' "$SourceOrigin,$Fallback"
Check $c3.ok "the CURRENT settings load in the STAGED bundle exactly as today  ($($c3.out))"
Check (-not (Test-Path -LiteralPath $ToolState)) "no earlier run of this plan ($ToolState)"
$u = Get-ScheduledTask -TaskPath '\Enclave\' -TaskName 'Update' -ErrorAction SilentlyContinue
Check (-not $u -or $u.State -ne 'Running') "the Update task is not running"
$ag = @(AgentProcs); $lp = @(LoopProcs)
Check ($ag.Count -eq 1 -and $lp.Count -eq 1) "one node agent ($(($ag | ForEach-Object { $_.ProcessId }) -join ',')) and one run-node.cmd loop ($(($lp | ForEach-Object { $_.ProcessId }) -join ','))"
Check (Healthy) "the agent answers /v1/health"
$m = LeaseMode
Check ($m.leaseGas -eq 'app-funded') "lease mode $($m.leaseGas) (operator $($m.operator))"
Check (Test-Path -LiteralPath $Node -PathType Leaf) "$Node ($(& $Node --version))"
$rt = Get-ScheduledTask -TaskPath '\Enclave\' -TaskName 'Relay' -ErrorAction SilentlyContinue
if (-not $AfterRelay) {
  Check (-not $rt) "no \Enclave\Relay task yet"
  Check (@(RelayProcs).Count -eq 0) "no relay process"
  Check (@(PortListeners $RelayPort).Count -eq 0) "nothing listens on 127.0.0.1:$RelayPort"
  Check (-not (Test-Path -LiteralPath $RelayKey) -and -not (Test-Path -LiteralPath $RelaySend)) "no relay key or send record on this host"
  $src = $null; try { $src = Invoke-RestMethod -TimeoutSec 8 "$SourceOrigin/v1/info" } catch {}
  Say "  the source relay $SourceOrigin answers: $(if ($src) { "payee $($src.payee) chain $($src.chainId)" } else { 'nothing (already stopped?)' })"
} else {
  Check ($rt -and $rt.State -ne 'Disabled') "the \Enclave\Relay task is registered and enabled"
  Check (@(RelayProcs).Count -eq 1) "one relay process"
  Check (RelayIsTheMovedKey) "the local relay answers as the moved key $Payee for the reviewed record"
}
Say "  VMs: $((Vms | ForEach-Object { "$($_.id)=$($_.status)" }) -join ' ')"
foreach ($t in 'Node', 'Shield', 'Network', 'Update', 'Relay') { $x = Get-ScheduledTask -TaskPath '\Enclave\' -TaskName $t -ErrorAction SilentlyContinue; Say "  task \Enclave\$t : $(if ($x) { $x.State } else { 'absent' })" }
Say "== $(if ($ok) { 'PREFLIGHT OK' } else { 'PREFLIGHT FAILED: do not continue' })"
if ($ok) { exit 0 } else { exit 1 }
