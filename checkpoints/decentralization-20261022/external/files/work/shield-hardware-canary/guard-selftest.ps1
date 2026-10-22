# SELF-TEST of the approval guard, touching NOTHING on the host: Require-Approval's return value, and gcs.ps1 in plan-only and
# unapproved modes against a SCRATCH directory standing in for the registry key. Exit 1 if any check fails.
param([Parameter(Mandatory)] [string]$ScratchDir)
. (Join-Path $PSScriptRoot "lib.ps1")
$ErrorActionPreference = "Continue"; $fail = 0
function Check($name, $ok) { if ($ok) { Write-Output "PASS $name" } else { Write-Output "FAIL $name"; $script:fail++ } }
New-Item -ItemType Directory -Force $ScratchDir | Out-Null; $root = Join-Path $ScratchDir "gcs-root"; New-Item -ItemType Directory -Force $root | Out-Null
$r = Require-Approval $ScratchDir "x"
Check "plan-only returns exactly `$false (not an array)" ($r -is [bool] -and $r -eq $false)
$threw = $false; try { [void](Require-Approval $ScratchDir "x" -Apply) } catch { $threw = $true }
Check "-Apply without an approval line throws" $threw
Set-Content (Join-Path $ScratchDir "approved-steps.txt") "approved: x"
$r = Require-Approval $ScratchDir "x" -Apply
Check "-Apply with the approval line returns exactly `$true" ($r -is [bool] -and $r -eq $true)
Remove-Item (Join-Path $ScratchDir "approved-steps.txt")
& (Join-Path $PSScriptRoot "gcs.ps1") -CanaryDir $ScratchDir -GcsRootOverride $root *> $null
Check "gcs.ps1 plan-only creates nothing" (@(Get-ChildItem $root).Count -eq 0)
try { & (Join-Path $PSScriptRoot "gcs.ps1") -CanaryDir $ScratchDir -GcsRootOverride $root -Apply *> $null } catch {}
Check "gcs.ps1 -Apply unapproved creates nothing" (@(Get-ChildItem $root).Count -eq 0)
Remove-Item $ScratchDir -Recurse -Force
exit $fail
