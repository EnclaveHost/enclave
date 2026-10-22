# 30-verify.ps1 - READ-ONLY, any time: the tool's status for this plan (each file's state, the agent's pid and health,
# the VMs), the lease mode and operator the agent reports, the scheduled tasks, whether the lease-gas settings are still
# the reviewed bytes and called (yes/no), and the node log's lease/release lines (e.g. a journaled release settled
# "unsent" by the new journal writer). No key, environment, database or journal content is read.
#   powershell -NoProfile -ExecutionPolicy Bypass -File <stage>\30-verify.ps1
param([string]$Stage = $PSScriptRoot, [int]$LogLines = 600)
. (Join-Path $Stage 'common.ps1')
& $Node $Tool status --plan $Plan
$m = LeaseMode; Say "lease mode: $($m.leaseGas) (operator $($m.operator))$(if ($m.error) { " - $($m.error)" })"
Say "agents: $((@(AgentProcs) | ForEach-Object { $_.ProcessId }) -join ',')  loops: $((@(LoopProcs) | ForEach-Object { $_.ProcessId }) -join ',')  healthy: $(Healthy)"
foreach ($t in 'Node', 'Shield', 'Network', 'Update') { $x = Get-ScheduledTask -TaskPath '\Enclave\' -TaskName $t -ErrorAction SilentlyContinue; Say "task \Enclave\$t : $(if ($x) { $x.State } else { 'absent' })" }
Say "lease-gas settings reviewed and called: $(SettingsOk)"
$log = Join-Path $PD 'logs\node.log'
if (Test-Path -LiteralPath $log) {
  Say "node.log lease lines (last $LogLines lines scanned):"
  Get-Content -LiteralPath $log -Tail $LogLines | Where-Object { $_ -match 'app-funded|lease-gas|reserve|\[claim\]|\[renew\]|release |\[release\]|wallet policy|EPERM' } | Select-Object -Last 50 | ForEach-Object { "  $_" }
}
