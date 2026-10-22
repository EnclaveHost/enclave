#Requires -RunAsAdministrator
# Start stage @LABEL@ (the task has no boot trigger: a reboot does not start it until root adds one). Then wait for health.
param([int]$WaitSeconds = 600)
. (Join-Path $PSScriptRoot 'common.ps1')
if (-not (Test-Path -LiteralPath $Receipt)) { Fail "stage $Label is not installed" }
if (-not (Get-ChildItem -LiteralPath "$Data\artifacts" -File | Select-Object -First 1)) { Fail 'no artifacts: run windows\fill-data.ps1 artifacts first' }
Start-ScheduledTask -TaskPath $TaskPath -TaskName $TaskName
& (Join-Path $PSScriptRoot 'health.ps1') -WaitSeconds $WaitSeconds
exit $LASTEXITCODE
