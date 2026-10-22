# release-channel-read.ps1 - ROOT-RUN, READ-ONLY (Windows PowerShell 5.1). The release-train facts check-release.py needs.
# Prints ONE JSON line: shas, versions, names, counts, task state. NEVER key bytes, tokens, config values or log lines.
$ErrorActionPreference = 'Stop'
$PF = Join-Path $env:ProgramFiles 'Enclave'; $PD = Join-Path $env:ProgramData 'Enclave'; $W = Join-Path $env:ProgramData 'Enclave-setup'
function Sha($p) { if (Test-Path -LiteralPath $p -PathType Leaf) { (Get-FileHash -Algorithm SHA256 -LiteralPath $p).Hash.ToLower() } else { 'absent' } }
$o = [ordered]@{ at = [DateTime]::UtcNow.ToString('o') }
# the installed release: its manifest (sha + version only) -> f509d0b4 = 2026.10.20.1, 5b966e81 = 2026.10.12.47
$m = Join-Path $PF 'manifest.json'; $o.manifestSha = Sha $m
$o.manifestVersion = $(try { [string]([IO.File]::ReadAllText($m) | ConvertFrom-Json).version } catch { $null })
$o.displayVersion = $(try { [string](Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\Enclave' -ErrorAction Stop).DisplayVersion } catch { $null })
# the updater that will judge the next release (e0d9df1c = legacy-only main; 96f19838 = signed-capable)
$o.updateHostSha = Sha (Join-Path $PF 'update-host.ps1')
# kept release bundles (a delta needs the installed one): directory NAMES only
$o.keptBundles = @(Get-ChildItem -LiteralPath $W -Directory -ErrorAction SilentlyContinue | ForEach-Object { $_.Name })
# the signed channel: PRESENCE, then only its public routing fields (no key bytes: a COUNT)
$rp = Join-Path $PD 'node\release-policy.json'; $o.releasePolicy = [ordered]@{ present = (Test-Path -LiteralPath $rp) }
if ($o.releasePolicy.present) { $j = [IO.File]::ReadAllText($rp) | ConvertFrom-Json
  $o.releasePolicy.format = [string]$j.format; $o.releasePolicy.channel = [string]$j.channel; $o.releasePolicy.threshold = $j.threshold
  $o.releasePolicy.mirrors = @($j.mirrors | ForEach-Object { [string]$_ }); $o.releasePolicy.keyCount = @($j.keys).Count; $o.releasePolicy.sha = Sha $rp }
# the updater task
$t = Get-ScheduledTask -TaskPath '\Enclave\' -TaskName 'Update' -ErrorAction SilentlyContinue
if ($t) { $i = Get-ScheduledTaskInfo -InputObject $t
  $o.updateTask = [ordered]@{ state = [string]$t.State; enabled = [bool]$t.Settings.Enabled; next = $(if ($i.NextRunTime) { $i.NextRunTime.ToUniversalTime().ToString('o') }); last = $(if ($i.LastRunTime) { $i.LastRunTime.ToUniversalTime().ToString('o') }); lastResult = [int64]$i.LastTaskResult } }
else { $o.updateTask = 'absent' }
# every other \Enclave\ task an install would stop and NOT restart (names + state)
$o.enclaveTasks = @(Get-ScheduledTask -TaskPath '\Enclave\' -ErrorAction SilentlyContinue | ForEach-Object { "$($_.TaskName)=$($_.State)" })
$o.hs2UnderProgramFiles = (Test-Path -LiteralPath (Join-Path $PF 'host-services\hs2'))
$o | ConvertTo-Json -Compress -Depth 5
