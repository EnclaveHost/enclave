# NucBox: put back the run-shield.cmd that shield-svn18.ps1 saved, and restart the Shield manager task.
$f='C:\ProgramData\Enclave\run-shield.cmd'
$bak="$f.bak-20261113-before-svn18"
$ErrorActionPreference='Stop'
$task=$null
$task=Get-ScheduledTask -TaskPath '\Enclave\' -TaskName Shield
if (-not $task) { 'STOP: the task \Enclave\Shield was not found; nothing changed'; exit 1 }
if (-not (Test-Path -LiteralPath $bak)) { 'STOP: no saved file; nothing changed'; exit 1 }
Copy-Item -LiteralPath $bak -Destination $f -Force
"restored: " + ((Get-Content -LiteralPath $f | Select-String -Pattern 'native-desktop-env').Line)
Stop-ScheduledTask -TaskPath '\Enclave\' -TaskName Shield
Start-Sleep -Seconds 4
Get-CimInstance Win32_Process -Filter "Name='cmd.exe'" | Where-Object { $_.CommandLine -match 'run-shield' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
Get-NetTCPConnection -LocalPort 8091 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1 | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }
Start-ScheduledTask -TaskPath '\Enclave\' -TaskName Shield
Start-Sleep -Seconds 25
try { "health: " + ((Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:8091/health' -TimeoutSec 8).Content.Substring(0,200)) } catch { "health: no answer yet" }
