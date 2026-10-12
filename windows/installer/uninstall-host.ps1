# uninstall-host.ps1 -- remove the Enclave host from this PC (the reverse of install-host.ps1). Run elevated:
#   powershell -ExecutionPolicy Bypass -File "C:\Program Files\Enclave\uninstall-host.ps1" [-RemoveData]
# Stops and removes the \Enclave\ tasks, their processes and every Enclave Shield VM, the tray and the program files.
# ProgramData\Enclave (this host's keys, its records, its logs) is KEPT unless -RemoveData, which MOVES it to
# ProgramData\Enclave-removed-<time> rather than deleting it: the operator key may still hold gas or earnings.
# Hyper-V and its host settings stay: other software may use them.
param([switch] $RemoveData)
$ErrorActionPreference = "Continue"
$PF = Join-Path $env:ProgramFiles "Enclave"; $PD = Join-Path $env:ProgramData "Enclave"
function Emit($step, $state, $message) { [ordered]@{ step = $step; state = $state; message = $message } | ConvertTo-Json -Compress | Write-Output }

foreach ($t in Get-ScheduledTask -TaskPath "\Enclave\" -ErrorAction SilentlyContinue) {
  Stop-ScheduledTask -TaskPath "\Enclave\" -TaskName $t.TaskName -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskPath "\Enclave\" -TaskName $t.TaskName -Confirm:$false
}
Emit "services" "ok" "The Enclave services are stopped and removed"
$roots = @($PF, $PD)
Get-CimInstance Win32_Process | Where-Object {
  $p = $_; ($p.ExecutablePath -and ($roots | Where-Object { $p.ExecutablePath.StartsWith($_, [StringComparison]::OrdinalIgnoreCase) })) -or
  ($p.Name -in "node.exe", "cmd.exe" -and $p.CommandLine -and ($roots | Where-Object { $p.CommandLine -like "*$_*" }))
} | Where-Object { $_.ProcessId -ne $PID } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Get-Process EnclaveTray -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep 2
foreach ($vm in Get-VM -ErrorAction SilentlyContinue | Where-Object { $_.Name -like "enclave-*" }) {
  Stop-VM -VM $vm -TurnOff -Force -ErrorAction SilentlyContinue; Remove-VM -VM $vm -Force
}
Emit "shield" "ok" "Enclave Shield's VMs are removed"
if (Test-Path (Join-Path $PF "tray\uninstall-tray.cmd")) { & cmd.exe /c (Join-Path $PF "tray\uninstall-tray.cmd") | Out-Null }
Emit "tray" "ok" "The tray is removed for $env:USERNAME (other accounts: run tray\uninstall-tray.cmd as them)"
Set-Location $env:SystemRoot
if (Test-Path $PF) { Remove-Item $PF -Recurse -Force }
Emit "files" "ok" "The program files are removed"
if ($RemoveData -and (Test-Path $PD)) {
  $to = "$PD-removed-" + (Get-Date).ToUniversalTime().ToString("yyyyMMddTHHmmssZ")
  Move-Item $PD $to; Emit "data" "ok" "This host's data (keys included) moved to $to"
} elseif (Test-Path $PD) { Emit "data" "ok" "This host's data (keys included) is kept in $PD; reinstalling reuses it" }
Emit "done" "ok" "The Enclave host is removed"
