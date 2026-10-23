# run-cpu-canary.ps1 - ROOT-RUN native canary for the share-sized processor allocation on NucBox (no app VM touched).
#
# Boots NEVER-SEEN, diskless, NIC-less type-1 VMs under the prefix below with the PRODUCTION guest image, guest-state
# master and pinned hyperv.psm1 (read from the manager's own shield-config.cmd, never typed), sized exactly as the
# candidate manager sizes a purchased share (cpu-share.mjs), one share at a time:
#   - the launcher's processor step sets Msvm_ProcessorSettingData Limit/Reservation and READS IT BACK (hard failure),
#   - the guest's own first console line "MON snp=0 vcpus=N" must show every VP online (SMP proof of runtime.bin),
#   - the VM is removed by its Id and its guest-state copy archived; survey-after must show no VM under the prefix.
# It loads no app, starts no wmiserve, writes no registry value (AllowFirmwareLoadFromFile must already be DWORD 1,
# as the production manager's preflight requires) and never touches a VM it did not create.
# Usage (elevated, on NucBox):  powershell -NoProfile -ExecutionPolicy Bypass -File run-cpu-canary.ps1 -Kit <dir> [-Shares 0.01,0.21,0.13]
param(
  [Parameter(Mandatory = $true)][string] $Kit,            # holds windows\vbslike\{manager,verify}\... from KIT-MANIFEST.json
  [double[]] $Shares = @(0.01, 0.21, 0.13),
  [int] $PoolVcpus = 0,                                    # 0 = the node's own rule: NODE_VCPUS, else the logical processor count
  [string] $Prefix = 'enclave-cpucanary-',
  [string] $Out = (Join-Path $env:ProgramData ('Enclave\logs\cpu-canary-' + (Get-Date).ToUniversalTime().ToString('yyyyMMdd-HHmmss')))
)
$ErrorActionPreference = 'Stop'
$PF = Join-Path $env:ProgramFiles 'Enclave'; $PD = Join-Path $env:ProgramData 'Enclave'
New-Item -ItemType Directory -Force -Path $Out | Out-Null
$cfgText = Get-Content -LiteralPath (Join-Path $PD 'shield-config.cmd')
function V($k) { $m = $cfgText | Select-String -Pattern ('^set ' + [regex]::Escape($k) + '=(.*)$') | Select-Object -Last 1
  if (-not $m) { throw "$k is not in shield-config.cmd" }; $m.Matches[0].Groups[1].Value.Trim() }
if ((V 'ENCLAVE_BOOT_FORM') -ne 'linux-direct') { throw 'this canary is for the linux-direct CPU image' }
if ($PoolVcpus -le 0) { $PoolVcpus = [int](Get-CimInstance Win32_ComputerSystem).NumberOfLogicalProcessors }
$lp = [int](Get-VMHost).LogicalProcessorCount
if ($PoolVcpus -gt $lp) { throw "pool $PoolVcpus exceeds Hyper-V LogicalProcessorCount $lp" }
if (@(Get-VM | Where-Object { $_.Name.StartsWith($Prefix) }).Count) { throw "VMs under $Prefix already exist: refusing (clean them first)" }
$node = Join-Path $PF 'runtime\node\node.exe'
$canary = Join-Path $Kit 'windows\vbslike\manager\ops\launcher-canary.mjs'
$summary = [ordered]@{ at = (Get-Date).ToUniversalTime().ToString('o'); poolVcpus = $PoolVcpus; hostLogicalProcessors = $lp; runs = @() }
try {
  foreach ($share in $Shares) {
    $cfg = [ordered]@{ imagePath = (V 'ENCLAVE_GUEST_IGVM'); imageSha256 = (V 'ENCLAVE_GUEST_IGVM_SHA256').ToLower(); boot = 'linux-direct';
      guestStateMaster = (V 'ENCLAVE_GUEST_STATE_MASTER'); guestStateMasterSha256 = (V 'ENCLAVE_GUEST_STATE_MASTER_SHA256').ToLower();
      guestStateArchiveDir = (V 'ENCLAVE_GUEST_STATE_ARCHIVE_DIR'); hypervModule = (V 'ENCLAVE_HYPERV_MODULE'); prefix = $Prefix;
      memMiB = 128; vcpus = 1; cpuPoolVcpus = $PoolVcpus; cpuShare = $share; guestReadySec = 40 }
    $tag = ('{0:0.####}' -f $share).Replace('.', 'p')
    $cfgFile = Join-Path $Out "cfg-$tag.json"; [System.IO.File]::WriteAllText($cfgFile, ($cfg | ConvertTo-Json -Compress))
    # native stderr under 'Stop' throws in Windows PowerShell 5.1 (install-host.ps1 relaxes it the same way, for this call only)
    $ErrorActionPreference = 'Continue'
    $lines = & $node $canary $cfgFile 2> (Join-Path $Out "err-$tag.txt"); $code = $LASTEXITCODE
    $ErrorActionPreference = 'Stop'
    Set-Content -LiteralPath (Join-Path $Out "out-$tag.jsonl") -Value $lines
    $steps = @($lines | ForEach-Object { try { $_ | ConvertFrom-Json } catch { $null } } | Where-Object { $_ })
    $cpu = $steps | Where-Object { $_.step -eq 'cpu' } | Select-Object -Last 1
    $summary.runs += [ordered]@{ share = $share; exit = $code; ok = ($code -eq 0);
      want = $cpu.want; readback = $cpu.readback; guestOnlineVcpus = $cpu.guestOnlineVcpus;
      error = ($steps | Where-Object { $_.step -eq 'error' } | Select-Object -First 1).error }
    if ($code -ne 0) { break }                              # stop at the first failure; its VM was removed by the canary
  }
} finally {
  # whatever happened, nothing under the prefix may remain; only VMs carrying our identity Notes are removed here
  $left = @(Get-VM | Where-Object { $_.Name.StartsWith($Prefix) })
  foreach ($v in $left) { if (([string]$v.Notes).StartsWith('enclave-vbslike-app-domain/manager|')) { Stop-VM -VM $v -TurnOff -Force -EA SilentlyContinue; Remove-VM -VM $v -Force } }
  $summary.leftBefore = $left.Count
  $summary.leftAfter = @(Get-VM | Where-Object { $_.Name.StartsWith($Prefix) }).Count
  $summary.ok = ($summary.leftAfter -eq 0) -and ($summary.runs.Count -eq $Shares.Count) -and -not ($summary.runs | Where-Object { -not $_.ok })
  ($summary | ConvertTo-Json -Depth 6) | Set-Content -LiteralPath (Join-Path $Out 'summary.json')
  $summary | ConvertTo-Json -Depth 6 -Compress
}
