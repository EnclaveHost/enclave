# 10-preflight.ps1 - READ-ONLY on minipc. Reports, without changing anything: the four control files' state (before/after via
# the activation tool's status), the 75 unchanged files' preflight (tool), the manager's /health image pins and
# directBootstrap, the VMs, the agent, the staged image (if any) and the sha256 (never the content) of the two settings files
# 40-enable-direct.ps1 would change. Ends "PREFLIGHT OK" only when the control files are all 'before' or all 'after'.
param([Parameter(Mandatory = $true)][string]$Stage)
. (Join-Path $Stage 'common.ps1')
$s = ToolStatus
Say "control files: $(($s.files | ForEach-Object { "$($_.path)=$($_.state)" }) -join ' ')"
$states = @($s.files | ForEach-Object { $_.state } | Sort-Object -Unique)
$h = MgrHealth
if ($h) { Say "manager: directBootstrap=$($h.supports.directBootstrap); legacy image=$($h.images.legacy.igvmSha256); shieldDirect=$(if ($h.images.shieldDirect) { "$($h.images.shieldDirect.igvmSha256) RuntimeID $($h.images.shieldDirect.runtimeId)" } else { 'none' })" }
else { Say "manager: /health unreachable" }
$v = Vms; Say "VMs: $(if ($v) { ($v | ForEach-Object { "$($_.id)=$($_.status)" }) -join ' ' } else { 'unknown' })"
Say "agent: $(@(AgentProcs).Count) process(es), healthy=$(Healthy)"
Say "staged image: $(if (Test-Path -LiteralPath (Join-Path $ImageDir $ImageFile)) { Sha (Join-Path $ImageDir $ImageFile) } else { 'absent' }) (pin $ImageSha)"
Say "settings sha256 (pass these to 40-enable-direct.ps1): shield-config.cmd $(Sha $ShieldCfg); node-config.local.cmd $(if (Sha $NodeLocal) { Sha $NodeLocal } else { 'absent' })"
Say "call lines present: manager $(HasLine $ShieldCfg $MgrCall); node $(HasLine $NodeLocal $NodeCall)"
if ($states.Count -eq 1 -and ($states[0] -eq 'before' -or $states[0] -eq 'after')) { Say "PREFLIGHT OK (control files all '$($states[0])')"; exit 0 }
Say "PREFLIGHT FAILED: control files are '$($states -join ',')'"; exit 1
