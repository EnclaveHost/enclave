# how common.ps1's Fail (Write-Error ... -ErrorAction Continue; exit 3) behaves in three invocation forms (writes nothing)
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force
$g = 'C:\ProgramData\Enclave\host-services-install-validation-20261021\w9\guard\guard.ps1'
$ErrorActionPreference = 'Continue'
$global:LASTEXITCODE = 0
try { & $g -InstallRoot 'C:\ProgramData\x' 2>$null | Out-Null; "A plain call: rc=$LASTEXITCODE" } catch { "A plain call: THREW " + [string]$_ }
$global:LASTEXITCODE = 0
try { $o = & $g -InstallRoot 'C:\ProgramData\x' *>&1 | ForEach-Object { [string]$_ }; "B *>&1 pipeline: rc=$LASTEXITCODE out=" + ($o -join ' / ') } catch { "B *>&1 pipeline: THREW " + [string]$_ }
$global:LASTEXITCODE = 0
$o = & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $g -InstallRoot 'C:\ProgramData\x' 2>&1 | ForEach-Object { [string]$_ }
"C child -File: rc=$LASTEXITCODE out=" + ($o -join ' / ')
