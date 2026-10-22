# Remove only VM ids in this stage's durable creation journal. The driver verifies scope and actual Hyper-V Notes first.
param([Parameter(Mandatory)][string]$CanaryDir, [Parameter(Mandatory)][string]$Baseline, [int]$Port = 18091, [switch]$Apply)
. (Join-Path $PSScriptRoot 'lib.ps1')
if ($Port -ne 18091) { throw 'cleanup only uses dedicated canary port 18091' }
if ((Require-Approval $CanaryDir 'cleanup' -Apply:$Apply) -ne $true) { return }
$stage = Get-Content -LiteralPath (Join-Path $CanaryDir 'stage.json') -Raw | ConvertFrom-Json
if ($stage.format -ne 'enclave-shield-hardware-canary-stage/2' -or $stage.port -ne 18091 -or
    $stage.prefix -cne $CanaryPrefix -or $stage.marker -cne 'enclave-canary-vbslike-domain' -or
    $stage.canaryDir -cne [IO.Path]::GetFullPath($CanaryDir)) { throw 'stage identity mismatch' }
$node = Join-Path $stage.bundle 'runtime\node\node.exe'
if ($stage.nodeSha256 -notmatch '^[0-9a-f]{64}$' -or (Get-FileHash -LiteralPath $node -Algorithm SHA256).Hash.ToLower() -ne $stage.nodeSha256) { throw 'staged Node executable does not match its pin' }
$journal = Join-Path $CanaryDir 'created-vms.json'
if (Test-Path -LiteralPath $journal) {
  $j = Get-Content -LiteralPath $journal -Raw | ConvertFrom-Json
  if ($j.format -ne 'enclave-canary-vms/1' -or $j.commit -cne $stage.commit -or $j.canaryDir -cne $stage.canaryDir) { throw 'creation journal belongs to another stage' }
  foreach ($record in @($j.records | Where-Object { $_.state -ne 'deleted' })) {
    if ($record.id -notmatch '^hv[0-9a-f]{32}$') { throw 'invalid journal record id' }
    & $node (Join-Path $PSScriptRoot 'canary.mjs') delete --canary-dir $CanaryDir --port $Port --id $record.id --apply
    if ($LASTEXITCODE -ne 0) { throw "deletion is unconfirmed for $($record.id); remaining resources left intact" }
  }
}
$left = @(Get-VM | Where-Object { $_.Name.StartsWith($CanaryPrefix) -or ([string]$_.Notes).StartsWith('enclave-canary-vbslike-domain/manager|') })
if ($left.Count) { throw "unresolved canary VMs remain ($($left.Count)); no task, registrations, keys or VMGS files removed" }
& (Join-Path $PSScriptRoot 'run-manager.ps1') -CanaryDir $CanaryDir -Stop -Apply
& (Join-Path $PSScriptRoot 'gcs.ps1') -CanaryDir $CanaryDir -Revert -Apply
# Production Update is never paused: the canary has a separate name AND Notes namespace.
Remove-Item -LiteralPath (Join-Path $CanaryDir 'shield\custody-callback.key') -Force -ErrorAction SilentlyContinue
# Keep journals, logs and VMGS evidence for review. No wildcard VMGS deletion.
& (Join-Path $PSScriptRoot 'invariants.ps1') -Baseline $Baseline
exit $LASTEXITCODE
