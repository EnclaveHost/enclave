# 90-rollback.ps1 - restores what this release changed, never automatically: (1) the settings backups (only if 40 ran;
# compare-and-swap back to the recorded bytes) and, if the manager settings were changed, a manager restart (the same
# unproven-invariant caveat as 40); (2) the four control files by the activation tool's journal (only the agent is ended).
# The staged image and this release's settings files are kept (inert without the call lines).
param([Parameter(Mandatory = $true)][string]$Stage, [switch]$Reviewed, [switch]$AcceptManagerRestart)
. (Join-Path $Stage 'common.ps1')
if (-not $Reviewed) { Say "refused: run with -Reviewed"; exit 2 }
$restartMgr = $false
if (Test-Path -LiteralPath $State) {
  foreach ($pair in @(@($ShieldCfg, 'shield-config.cmd'), @($NodeLocal, 'node-config.local.cmd'))) {
    $file = $pair[0]; $bak = Join-Path $State ($pair[1] + '.before')
    if (Test-Path -LiteralPath $bak) { Copy-Item -LiteralPath $bak -Destination "$file.rollback.tmp" -Force; Move-Item -LiteralPath "$file.rollback.tmp" -Destination $file -Force
      if ((Sha $file) -ne (Sha $bak)) { Say "error: $file did not restore"; exit 1 }; Say "restored $file"; if ($pair[1] -eq 'shield-config.cmd') { $restartMgr = $true } }
    elseif (Test-Path -LiteralPath ($bak + '.absent')) { Remove-Item -LiteralPath $file -Force -ErrorAction SilentlyContinue; Say "removed $file (absent before)" }
  }
  Rename-Item -LiteralPath $State -NewName ((Split-Path $State -Leaf) + '.rolled-back-' + [DateTime]::UtcNow.ToString('yyyyMMddTHHmmss'))
}
if ($restartMgr) {
  if (-not $AcceptManagerRestart) { Say "settings restored; the manager still runs the Shield-direct settings until restarted: rerun with -AcceptManagerRestart"; exit 3 }
  Stop-ScheduledTask -TaskPath '\Enclave\' -TaskName 'Shield'; Start-Sleep 3; Start-ScheduledTask -TaskPath '\Enclave\' -TaskName 'Shield'; Say "manager restarted"
}
& $Node $Tool rollback --plan $Plan --observe-sec 120
$code = $LASTEXITCODE; Say "activate-control-source rollback exit $code"; exit $code
