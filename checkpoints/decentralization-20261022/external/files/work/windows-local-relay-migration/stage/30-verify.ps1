# 30-verify.ps1 - READ-ONLY, any time: the tool's status for the plan, the settings state (before/after/other by hash), the
# lease mode, the tasks, the local relay's public answer and the send record's SHAPE (nonce and hash, public), and the
# relay and node log lease lines. No key, environment, database or journal content is read.
#   powershell -NoProfile -ExecutionPolicy Bypass -File <stage>\30-verify.ps1
param([string]$Stage = $PSScriptRoot, [int]$LogLines = 600)
. (Join-Path $Stage 'common.ps1')
& $Node $Tool status --plan $Plan
Say "lease-gas-config.cmd: $(CfgState) ($(Sha $LeaseCmd)); called: $(SettingsCalled)"
$m = LeaseMode; Say "lease mode: $($m.leaseGas) (operator $($m.operator))$(if ($m.error) { " - $($m.error)" })"
Say "agents: $((@(AgentProcs) | ForEach-Object { $_.ProcessId }) -join ',')  loops: $((@(LoopProcs) | ForEach-Object { "$($_.ProcessId) started $($_.CreationDate)" }) -join ',')  healthy: $(Healthy)"
foreach ($t in 'Node', 'Shield', 'Network', 'Update', 'Relay') { $x = Get-ScheduledTask -TaskPath '\Enclave\' -TaskName $t -ErrorAction SilentlyContinue; Say "task \Enclave\$t : $(if ($x) { $x.State } else { 'absent' })" }
$ri = RelayInfo
Say "local relay ${RelayUrl}: $(if ($ri) { "payee $($ri.payee) chain $($ri.chainId) reserve $($ri.reserve)" } else { 'no answer' }); the moved key: $(RelayIsTheMovedKey); processes $(@(RelayProcs).Count)"
if (Test-Path -LiteralPath $RelaySend) {
  try { $r = Get-Content -LiteralPath $RelaySend -Raw | ConvertFrom-Json; Say "send record: $(if ($r.hash) { "UNRESOLVED nonce $($r.nonce) hash $($r.hash)" } else { 'nothing unresolved' })" } catch { Say "send record: not JSON" }
}
foreach ($pair in @(@('lease-relay.log', '\[relay\]|relayed|LeaseGasPaid|refus|error|WARNING|configuration'), @('node.log', 'app-funded|lease-gas|reserve|relay|\[claim\]|\[renew\]|\[release\]|NotRelayed|RelayBusy'))) {
  $log = Join-Path $PD "logs\$($pair[0])"
  if (Test-Path -LiteralPath $log) {
    Say "$($pair[0]) lease lines (last $LogLines lines scanned):"
    Get-Content -LiteralPath $log -Tail $LogLines | Where-Object { $_ -match $pair[1] } | Select-Object -Last 40 | ForEach-Object { "  $_" }
  }
}
