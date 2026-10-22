# 40-enable-direct.ps1 - turns ON the Shield-direct image (owner-committed startup) on this host. RESTARTS THE MANAGER
# (task \Enclave\Shield): with running VMs that restart is the step whose invariants are NOT all proven
# (test/windows-isolation-manager-restart.test.mjs P1/P1b/P1c and "Hyper-V unreadable at restart" are still TODO), so it
# refuses without -AcceptManagerRestart. Settings: ONE call line appended (compare-and-swap on the preflight's sha256, verified
# backup) to shield-config.cmd and to node-config.local.cmd, calling this release's public settings files.
param([Parameter(Mandatory = $true)][string]$Stage, [Parameter(Mandatory = $true)][string]$ShieldCfgBefore,
      [Parameter(Mandatory = $true)][string]$NodeLocalBefore, [switch]$Reviewed, [switch]$AcceptManagerRestart)
. (Join-Path $Stage 'common.ps1')
if (-not ($Reviewed -and $AcceptManagerRestart)) { Say "refused: needs -Reviewed and -AcceptManagerRestart (see the header)"; exit 2 }
if ((Sha (Join-Path $ImageDir $ImageFile)) -ne $ImageSha) { Say "refused: the image is not staged (30-stage-image.ps1)"; exit 2 }
if (Test-Path -LiteralPath $State) { Say "refused: $State exists (an earlier run): 50-verify.ps1, then 90-rollback.ps1"; exit 2 }
New-Item -ItemType Directory -Path $State | Out-Null
foreach ($f in 'shield-direct-manager.cmd', 'shield-direct-node.cmd') {
  $dst = Join-Path $DirectDir $f; $src = Join-Path $Stage "settings\$f"
  if ((Test-Path -LiteralPath $dst) -and (Sha $dst) -ne (Sha $src)) { Say "refused: $dst exists with other bytes"; exit 2 }
  Copy-Item -LiteralPath $src -Destination $dst -Force
}
$vmsBefore = Vms
try { $m = AppendCall $ShieldCfg $MgrCall $ShieldCfgBefore; $n = AppendCall $NodeLocal $NodeCall $NodeLocalBefore; Say "settings: shield-config.cmd -> $m; node-config.local.cmd -> $n" }
catch { Say "error: $($_.Exception.Message); 90-rollback.ps1 restores any backup"; exit 1 }
Stop-ScheduledTask -TaskPath '\Enclave\' -TaskName 'Shield'; Start-Sleep 3; Start-ScheduledTask -TaskPath '\Enclave\' -TaskName 'Shield'
$ok = $false
for ($i = 0; $i -lt 180 -and -not $ok; $i++) { Start-Sleep 1; $h = MgrHealth; $ok = $h -and $h.supports.directBootstrap -and $h.images.shieldDirect.igvmSha256 -eq $ImageSha -and $h.images.shieldDirect.runtimeId -eq $RuntimeId }
Say "manager: shieldDirect $(if ($ok) { 'ON with the pinned image' } else { 'NOT observed' }); VMs before $(@($vmsBefore).Count) after $(@(Vms).Count)"
foreach ($p in @(AgentProcs)) { Stop-Process -Id $p.ProcessId -Force }   # the run-node.cmd loop starts the agent with the new pins
for ($i = 0; $i -lt 120 -and -not (Healthy); $i++) { Start-Sleep 1 }
if ($ok -and (Healthy)) { Say "ENABLED"; exit 0 } else { Say "UNOBSERVED: 50-verify.ps1; if it stays so, 90-rollback.ps1"; exit 3 }
