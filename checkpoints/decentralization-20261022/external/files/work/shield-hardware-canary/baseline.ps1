# READ-ONLY: the host's state before the canary (production VMs, GuestCommunicationServices, \Enclave tasks, installed release).
param([Parameter(Mandatory)] [string]$CanaryDir)
. (Join-Path $PSScriptRoot "lib.ps1")
New-Item -ItemType Directory -Force $CanaryDir | Out-Null
$s = Snapshot
$out = Join-Path $CanaryDir ("baseline-" + (Get-Date).ToUniversalTime().ToString("yyyyMMdd-HHmmss") + ".json")
$s | ConvertTo-Json -Depth 5 | Set-Content -Encoding UTF8 $out
Write-Output "baseline: $($s.vms.Count) VMs ($(@($s.vms | Where-Object { $_.name.StartsWith($CanaryPrefix) }).Count) canary), $($s.gcs.Count) services -> $out"
