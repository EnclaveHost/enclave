# 00-verify-stage.ps1 - READ-ONLY: every staged file has the sha256 in SHA256SUMS (and nothing else is staged).
#   powershell -NoProfile -ExecutionPolicy Bypass -File <stage>\00-verify-stage.ps1
param([string]$Stage = $PSScriptRoot)
. (Join-Path $Stage 'common.ps1')
$sums = Join-Path $Stage 'SHA256SUMS'
$want = @{}; foreach ($l in Get-Content -LiteralPath $sums) { if ($l -match '^([0-9a-f]{64})  (.+)$') { $want[$Matches[2]] = $Matches[1] } }
$bad = @()
foreach ($k in $want.Keys) { $got = Sha (Join-Path $Stage ($k -replace '/', '\')); if ($got -ne $want[$k]) { $bad += "$k is $got, not $($want[$k])" } }
$extra = @(Get-ChildItem -LiteralPath $Stage -Recurse -File | ForEach-Object { $_.FullName.Substring($Stage.TrimEnd('\').Length + 1).Replace('\', '/') } |
  Where-Object { $_ -ne 'SHA256SUMS' -and -not $want.ContainsKey($_) })
if ($extra.Count) { $bad += "not in SHA256SUMS: $($extra -join ', ')" }
if ($bad.Count) { $bad | ForEach-Object { Say "STAGE BAD: $_" }; exit 1 }
Say "stage ok: $($want.Count) files match SHA256SUMS ($(Sha $sums))"
exit 0
