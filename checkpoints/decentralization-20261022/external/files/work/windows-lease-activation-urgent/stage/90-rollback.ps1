# 90-rollback.ps1 - EXACT rollback of 20-activate.ps1 (root runs it; never automatic).
#   powershell -NoProfile -ExecutionPolicy Bypass -File <stage>\90-rollback.ps1            (source + settings, then Node restarts)
#   ... -ConfigOnly   (used by 20-activate.ps1 when it refuses: only the settings step; the Node task is not touched)
# 1. the Node task disabled + stopped (agent and loop only).
# 2. the tool's journaled rollback of the source (each written file restored from its verified backup; a file changed by
#    anyone since is reported, never overwritten). Whatever the tool's exit, its own status must then show EVERY plan
#    file as its previous version - otherwise (conflict, refusal, unknown) the Node task stays DISABLED.
# 3. the config target back to its exact previous bytes, keeping the file's own ACL - only if it is still exactly what
#    the activation left (or deleted, if the activation created it). Any other content is DRIFT: nothing is rewritten,
#    the Node task stays disabled, root reconciles by hand.
# 4. the two lease-gas files removed (only if they are the reviewed bytes and the activation installed them).
# 5. the Node task enabled and started: the previous code with the previous settings. The VM manager is never touched.
# Exit 0 rolled back | 1 refused/conflict/drift: Node left DISABLED.
param([string]$Stage = $PSScriptRoot, [switch]$ConfigOnly)
. (Join-Path $Stage 'common.ps1')
function Stay([string]$why) { Say "NOT ROLLED BACK: $why. The Node task stays DISABLED; nothing else was rewritten"; exit 1 }

if (-not $ConfigOnly) {
  Disable-ScheduledTask -TaskPath '\Enclave\' -TaskName 'Node' | Out-Null
  Stop-ScheduledTask -TaskPath '\Enclave\' -TaskName 'Node' -ErrorAction SilentlyContinue
  for ($i = 0; $i -lt 30 -and ((LoopProcs).Count -or (AgentProcs).Count); $i++) { Start-Sleep 1 }
  foreach ($p in (LoopProcs)) { Stop-Process -Id $p.ProcessId -Force }
  foreach ($p in (AgentProcs)) { Stop-Process -Id $p.ProcessId -Force }
  Start-Sleep 2
  if ((LoopProcs).Count -or (AgentProcs).Count) { Stay "the node agent could not be stopped" }
  & $Node $Tool rollback --plan $Plan --observe-sec 5
  $code = $LASTEXITCODE
  Say "activate-control-source rollback exit $code"
  if ($code -eq 1) { Stay "the tool reported a conflict or error (see its status)" }
  if (-not (AllBefore)) { Stay "after the tool's rollback (exit $code) not every plan file is its previous version" }
  Say "every plan file is its previous version (tool status)"
}

$rec = Join-Path $CfgState 'config.json'
if (Test-Path -LiteralPath $rec) {
  $r = Get-Content -LiteralPath $rec -Raw | ConvertFrom-Json
  $afterFile = Join-Path $CfgState 'config.after.json'
  $a = if (Test-Path -LiteralPath $afterFile) { Get-Content -LiteralPath $afterFile -Raw | ConvertFrom-Json } else { $null }
  $t = [string]$r.target; $cur = Sha $t
  if ($cur -eq $r.beforeHash) { Say "$t already has its previous bytes" }
  elseif ($a -and $cur -eq $a.afterHash) {
    if ($r.existed) {
      $b = Join-Path $CfgState 'config-target.before'
      if ((Sha $b) -ne $r.beforeHash) { Stay "the kept previous bytes of $t do not verify" }
      RestoreKeepAcl $b $t
      if ((Sha $t) -ne $r.beforeHash) { Stay "$t does not verify after the restore" }
      Say "$t restored to its previous bytes (its own ACL kept)"
    } else { Remove-Item -LiteralPath $t -Force; Say "$t removed (the activation created it)" }
  } else { Stay "$t has changed since the activation (neither its previous nor the activated bytes): reconcile by hand" }
  foreach ($f in $Want.Keys) {
    $p = Join-Path $LeaseDir $f
    if ((Sha $p) -eq $Want[$f] -and -not $r.leaseFilesBefore.$f) { Remove-Item -LiteralPath $p -Force; Say "removed $p" }
  }
  if (-not $r.leaseDirExisted -and (Test-Path -LiteralPath $LeaseDir) -and -not (Get-ChildItem -LiteralPath $LeaseDir -Force)) { Remove-Item -LiteralPath $LeaseDir -Force }
  $stamp = [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssZ')
  Move-Item -LiteralPath $rec -Destination "$rec.rolled-back-$stamp"
  if ($a) { Move-Item -LiteralPath $afterFile -Destination "$afterFile.rolled-back-$stamp" }
} else { Say "no settings record ($rec): the settings step never ran" }

if ($ConfigOnly) { exit 0 }
Enable-ScheduledTask -TaskPath '\Enclave\' -TaskName 'Node' | Out-Null
Start-ScheduledTask -TaskPath '\Enclave\' -TaskName 'Node'
for ($i = 0; $i -lt 120; $i++) { Start-Sleep 1; if ((AgentProcs).Count -eq 1) { try { if ((Invoke-RestMethod -TimeoutSec 3 'http://127.0.0.1:9600/v1/health').ok) { break } } catch {} } }
Say "ROLLED BACK: lease mode now '$((LeaseMode).leaseGas)' (the previous code and settings)"
& $Node $Tool status --plan $Plan
exit 0
