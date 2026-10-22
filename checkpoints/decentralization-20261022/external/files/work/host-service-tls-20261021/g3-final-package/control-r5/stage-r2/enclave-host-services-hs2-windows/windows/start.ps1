#Requires -RunAsAdministrator
# Start stage hs2 (the task has no boot trigger: a reboot does not start it until root adds one). Then wait for health.
param([int]$WaitSeconds = 600, [string]$InstallRoot = '', [string]$TaskName = '')
. (Join-Path $PSScriptRoot 'common.ps1')
Use-StageRoot
if (-not (Test-Path -LiteralPath $Receipt)) { Fail "stage $Label is not installed" }
if (-not (Get-ChildItem -LiteralPath "$Data\artifacts" -File | Select-Object -First 1)) { Fail 'no artifacts: run windows\fill-data.ps1 artifacts first' }
Start-ScheduledTask -TaskPath $TaskPath -TaskName $TaskName
$iso = @{}; if ($Isolated) { $iso = @{ InstallRoot = $Isolated; TaskName = $IsoTask } }
& (Join-Path $PSScriptRoot 'health.ps1') -WaitSeconds $WaitSeconds @iso
exit $LASTEXITCODE
