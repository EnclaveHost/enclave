# 30-verify.ps1 - READ-ONLY check after 20-activate.ps1 (or any time): the tool's status (every plan file's state, the
# agent's pid and health, the VMs), the lease mode the agent reports, the tasks, the installed settings' hashes, whether
# the call line is in place (yes/no), and the node log's lease lines (claims/renewals through the app reserve).
#   powershell -NoProfile -ExecutionPolicy Bypass -File <stage>\30-verify.ps1
param([string]$Stage = $PSScriptRoot, [int]$LogLines = 400)
. (Join-Path $Stage 'common.ps1')
& $Node $Tool status --plan $Plan
$m = LeaseMode; Say "lease mode: $($m.leaseGas) (operator $($m.operator))$(if ($m.error) { " - $($m.error)" })"
foreach ($t in 'Node', 'Shield', 'Network', 'Update') { $x = Get-ScheduledTask -TaskPath '\Enclave\' -TaskName $t -ErrorAction SilentlyContinue; Say "task \Enclave\$t : $(if ($x) { $x.State } else { 'absent' })" }
foreach ($f in $Want.Keys) { $h = Sha (Join-Path $LeaseDir $f); Say "$f : $h $(if ($h -eq $Want[$f]) { '(reviewed)' } else { '** NOT the reviewed bytes **' })" }
$target = ConfigTarget; Say "call line in $target : $(HasLine $target $CallLine)"
$log = Join-Path $PD 'logs\node.log'
if (Test-Path -LiteralPath $log) {
  Say "node.log lease lines (last $LogLines lines scanned):"
  Get-Content -LiteralPath $log -Tail $LogLines | Where-Object { $_ -match 'app-funded|lease-gas|LeaseGas|reserve|\[claim\]|\[renew\]|\[release\]|operator has no gas' } | Select-Object -Last 40 | ForEach-Object { "  $_" }
}
