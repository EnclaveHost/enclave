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
# Processes are matched by the install's ABSOLUTE paths only (never a bare *agent.mjs*/*main.mjs*: a tray or a lab
# manager also runs node.exe), and each run-*.cmd loop is stopped before its node.exe, or it would bring it back. The VM
# cleanup holds C:\Users\claude\uefi-probe.lock exclusively (as the lab harnesses and host-prereq.ps1 take it), so a
# concurrent lab run's VMs are never touched (enclave-d1's review, item 6).
# The M3 host settings are reverted separately (enclave-53's host-prereq.ps1 -Rollback), and the relay switch on nan
# separately (relay-hvnode-attach-off.sh).
param([switch]$Unregister, [string]$Root = 'C:\Users\claude\vbs-like\hvnode', [int]$ManagerPort = 8091)
$ErrorActionPreference = 'Continue'
function Note([string]$m) { Write-Output "ok   $m" }
$fail = @()
function Procs([string]$name, [string]$like) { @(Get-CimInstance Win32_Process -Filter "Name='$name'" | Where-Object { $_.CommandLine -like $like }) }
function StopLoop([string]$runCmd, [string]$scriptLike, [string]$what) {
  foreach ($p in @(Procs 'cmd.exe' "*$runCmd*")) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue; Note "$what loop (cmd.exe pid $($p.ProcessId)) stopped" }
  foreach ($p in @(Procs 'node.exe' $scriptLike)) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue; Note "$what node.exe pid $($p.ProcessId) stopped" }
}

$node = Get-ScheduledTask -TaskName 'EnclaveHvNode' -TaskPath '\' -ErrorAction SilentlyContinue
if ($node) { Disable-ScheduledTask -TaskName 'EnclaveHvNode' -TaskPath '\' | Out-Null; Stop-ScheduledTask -TaskName 'EnclaveHvNode' -TaskPath '\' -ErrorAction SilentlyContinue; Note 'node task disabled and ended' }
Start-Sleep -Seconds 3
StopLoop "$Root\run-node.cmd" "*$Root\*\windows\node\agent.mjs*" 'node agent'

try {
  $vms = (Invoke-RestMethod -Uri "http://127.0.0.1:$ManagerPort/vms" -TimeoutSec 15 -UseBasicParsing).vms
  foreach ($v in @($vms)) {
    try { Invoke-RestMethod -Method Delete -Uri "http://127.0.0.1:$ManagerPort/vms/$([uri]::EscapeDataString($v.id))" -TimeoutSec 60 -UseBasicParsing | Out-Null; Note "manager destroyed VM $($v.id) ($($v.name))" }
    catch { $fail += "manager DELETE /vms/$($v.id): $($_.Exception.Message)" } }
} catch { Write-Output "note: manager /vms unreachable ($($_.Exception.Message)); step 3 removes its VMs directly" }

$mgr = Get-ScheduledTask -TaskName 'EnclaveHvManager' -TaskPath '\' -ErrorAction SilentlyContinue
if ($mgr) { Disable-ScheduledTask -TaskName 'EnclaveHvManager' -TaskPath '\' | Out-Null; Stop-ScheduledTask -TaskName 'EnclaveHvManager' -TaskPath '\' -ErrorAction SilentlyContinue; Note 'manager task disabled and ended' }
Start-Sleep -Seconds 3
StopLoop "$Root\run-manager.cmd" "*$Root\manager-*\control\windows\vbslike\manager\main.mjs*" 'manager'

# the leftover manager-tagged VMs, ONLY while holding the lab lock: a lab run holding it owns the VMs on the box then
$lock = $null
try { $lock = [System.IO.File]::Open('C:\Users\claude\uefi-probe.lock', 'OpenOrCreate', 'ReadWrite', 'None') }
catch { $fail += 'C:\Users\claude\uefi-probe.lock is held (a lab or acceptance run is active): the VM cleanup was NOT done; re-run after it ends' }
if ($lock) {
  try {
    foreach ($v in @(Get-VM -ErrorAction SilentlyContinue | Where-Object { $_.Notes -like 'enclave-vbslike-app-domain*' })) {
      Stop-VM -VM $v -TurnOff -Force -ErrorAction SilentlyContinue; Start-Sleep -Seconds 3; Remove-VM -VM $v -Force -ErrorAction SilentlyContinue
      Note "leftover manager VM $($v.Name) turned off and removed (guest-state copy kept)" }
    if (@(Get-VM -ErrorAction SilentlyContinue | Where-Object { $_.Notes -like 'enclave-vbslike-app-domain*' }).Count) { $fail += 'a manager-tagged VM is STILL present' }
  } finally { $lock.Dispose() }
}

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
Write-Output "ROLLED BACK: nothing of the hv node runs; $Root kept. Next if wanted: host-prereq.ps1 -Rollback (M3); relay-hvnode-attach-off.sh on nan"
