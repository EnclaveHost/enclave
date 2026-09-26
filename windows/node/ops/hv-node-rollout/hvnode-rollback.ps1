# hvnode-rollback.ps1 - take the hv node and its manager back OUT of service on the NucBox (ROLLOUT.md, Rollback).
# It returns the box to its state before this rollout: nothing serving. The legacy node is RETIRED (Steven), so a
# rollback never enables \EnclaveWindowsNode. Nothing is deleted: the install root, its state\ keys, logs and the
# archived guest-state copies all stay.
#   powershell -ExecutionPolicy Bypass -File hvnode-rollback.ps1 [-Unregister]
# Order:
#   1. the node's task is disabled and ended FIRST, so it takes no new lease. Its leases lapse on the ledger's clock;
#      a lapsed lease is re-claimable elsewhere and is not renewed.
#   2. every VM the manager holds is destroyed THROUGH the manager (DELETE /vms/<id>), then its task is disabled and
#      ended;
#   3. any VM still tagged as the manager's (Notes enclave-vbslike-app-domain*) is turned off and removed, as enclave-d1's
#      manager-accept.ps1 cleanup does. Its per-run guest-state copy is kept.
#   4. -Unregister also removes the two task definitions. Their XML is exported next to the logs first.
# The M3 host settings are reverted separately (hvnode-m3.ps1 -Revert), and the relay switch on nan separately
# (relay-hvnode-attach-off.sh).
param([switch]$Unregister, [string]$Root = 'C:\Users\claude\vbs-like\hvnode', [int]$ManagerPort = 8091)
$ErrorActionPreference = 'Continue'
function Note([string]$m) { Write-Output "ok   $m" }
$fail = @()

$node = Get-ScheduledTask -TaskName 'EnclaveHvNode' -TaskPath '\' -ErrorAction SilentlyContinue
if ($node) { Disable-ScheduledTask -TaskName 'EnclaveHvNode' -TaskPath '\' | Out-Null; Stop-ScheduledTask -TaskName 'EnclaveHvNode' -TaskPath '\' -ErrorAction SilentlyContinue; Note 'node task disabled and ended' }
Start-Sleep -Seconds 3
foreach ($p in @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*agent.mjs*' -and $_.CommandLine -notlike '*\vbs\node*' })) {
  Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue; Note "node agent pid $($p.ProcessId) stopped" }

try {
  $vms = (Invoke-RestMethod -Uri "http://127.0.0.1:$ManagerPort/vms" -TimeoutSec 15 -UseBasicParsing).vms
  foreach ($v in @($vms)) {
    try { Invoke-RestMethod -Method Delete -Uri "http://127.0.0.1:$ManagerPort/vms/$([uri]::EscapeDataString($v.id))" -TimeoutSec 60 -UseBasicParsing | Out-Null; Note "manager destroyed VM $($v.id) ($($v.name))" }
    catch { $fail += "manager DELETE /vms/$($v.id): $($_.Exception.Message)" } }
} catch { Write-Output "note: manager /vms unreachable ($($_.Exception.Message)); step 3 removes its VMs directly" }

$mgr = Get-ScheduledTask -TaskName 'EnclaveHvManager' -TaskPath '\' -ErrorAction SilentlyContinue
if ($mgr) { Disable-ScheduledTask -TaskName 'EnclaveHvManager' -TaskPath '\' | Out-Null; Stop-ScheduledTask -TaskName 'EnclaveHvManager' -TaskPath '\' -ErrorAction SilentlyContinue; Note 'manager task disabled and ended' }
Start-Sleep -Seconds 3
foreach ($p in @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*main.mjs*' })) {
  Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue; Note "manager pid $($p.ProcessId) stopped" }

foreach ($v in @(Get-VM -ErrorAction SilentlyContinue | Where-Object { $_.Notes -like 'enclave-vbslike-app-domain*' })) {
  Stop-VM -VM $v -TurnOff -Force -ErrorAction SilentlyContinue; Start-Sleep -Seconds 3; Remove-VM -VM $v -Force -ErrorAction SilentlyContinue
  Note "leftover manager VM $($v.Name) turned off and removed (guest-state copy kept)" }
if (@(Get-VM -ErrorAction SilentlyContinue | Where-Object { $_.Notes -like 'enclave-vbslike-app-domain*' }).Count) { $fail += 'a manager-tagged VM is STILL present' }

if ($Unregister) {
  foreach ($t in 'EnclaveHvNode', 'EnclaveHvManager') {
    if (Get-ScheduledTask -TaskName $t -TaskPath '\' -ErrorAction SilentlyContinue) {
      $xml = Join-Path $Root ("logs\$t-" + (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssZ') + '.xml')
      Export-ScheduledTask -TaskName $t -TaskPath '\' | Set-Content -Path $xml -Encoding Unicode
      Unregister-ScheduledTask -TaskName $t -TaskPath '\' -Confirm:$false; Note "task \$t unregistered (definition kept at $xml)" } }
}
$legacy = Get-ScheduledTask -TaskName 'EnclaveWindowsNode' -TaskPath '\' -ErrorAction SilentlyContinue
if (-not $legacy -or $legacy.State -ne 'Disabled') { $fail += 'the legacy task is not present-and-Disabled (never enable or delete it)' } else { Note 'legacy task untouched (Disabled)' }
if ($fail.Count) { $fail | ForEach-Object { Write-Output "FAIL $_" }; exit 1 }
Write-Output "ROLLED BACK: nothing of the hv node runs; $Root kept. Next if wanted: hvnode-m3.ps1 -Revert; relay-hvnode-attach-off.sh on nan"
