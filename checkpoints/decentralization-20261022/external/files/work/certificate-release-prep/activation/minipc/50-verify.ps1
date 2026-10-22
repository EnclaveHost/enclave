# 50-verify.ps1 - READ-ONLY: the control files, the manager's Shield-direct pins, the VMs, the agent, and the node log's
# app-zone/owner-name host-session lines (shield-sessions.mjs logs a failed session; a running package naming replicas makes
# sessions). Ends VERIFIED when the control files are 'after' and (if enabled) the manager states the pinned image.
param([Parameter(Mandatory = $true)][string]$Stage)
. (Join-Path $Stage 'common.ps1')
$s = ToolStatus; $after = @($s.files | Where-Object { $_.state -ne 'after' }).Count -eq 0
$h = MgrHealth; $enabled = HasLine $ShieldCfg $MgrCall
$direct = $h -and $h.images.shieldDirect.igvmSha256 -eq $ImageSha -and $h.images.shieldDirect.runtimeId -eq $RuntimeId
Say "control files after: $after; Shield-direct enabled in settings: $enabled; manager states the pinned image: $direct; agent healthy: $(Healthy)"
Say "VMs: $((Vms | ForEach-Object { "$($_.id)=$($_.status)" }) -join ' ')"
$log = Join-Path $PD 'logs\node.log'
if (Test-Path -LiteralPath $log) { Get-Content -LiteralPath $log -Tail 400 | Select-String -SimpleMatch -Pattern 'shield responder session','app-zone' | Select-Object -Last 10 | ForEach-Object { Say "log: $($_.Line)" } }
if ($after -and (-not $enabled -or $direct)) { Say 'VERIFIED'; exit 0 } else { Say 'NOT VERIFIED'; exit 1 }
