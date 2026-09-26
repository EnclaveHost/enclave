# hvnode-m3.ps1 - the M3 PERMANENT host prerequisites for serving on the NucBox (READINESS.md M3; approved by
# enclave-87 with Steven's authority, 2026-09-26). The same two settings enclave-d1's manager-accept.ps1 applies for ONE
# run and undoes, made permanent, with the prior state recorded so -Revert puts back exactly what was there:
#   1. HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Virtualization  AllowFirmwareLoadFromFile = DWORD 1
#      (lets Hyper-V load OUR measured IGVM firmware file; host-wide, for every VM created while it is set; no reboot)
#   2. ...\Virtualization\GuestCommunicationServices\00002329-facb-11e6-bd58-64006a7986d3  (hv_sock port 9001, where the
#      host signs the guest's report requests; without it the launcher's bind fails with 10013)
#   powershell -ExecutionPolicy Bypass -File hvnode-m3.ps1 -Status | -Apply | -Revert
# -Apply refuses if a prior-state record already exists (no double apply). -Revert restores the recorded prior state
# (the value, or its absence; the GUID removed only if -Apply added it) and verifies it. enclave-53's v41 package will
# carry the same as packaged scripts; this one is for the v40 rollout and must not be mixed with those on one box.
param([switch]$Status, [switch]$Apply, [switch]$Revert,
      [string]$Record = 'C:\Users\claude\vbs-like\hvnode\m3-prior-state.json')
$ErrorActionPreference = 'Stop'
$virt = 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Virtualization'
$name = 'AllowFirmwareLoadFromFile'
$svc = Join-Path $virt 'GuestCommunicationServices\00002329-facb-11e6-bd58-64006a7986d3'
function Read-State {
  $p = Get-ItemProperty -Path $virt -Name $name -ErrorAction SilentlyContinue
  $kind = $null; if ($null -ne $p) { $kind = (Get-Item $virt).GetValueKind($name).ToString() }
  [ordered]@{ afl = $(if ($null -eq $p) { $null } else { [int]$p.$name }); aflKind = $kind; guid = (Test-Path $svc) }
}
function Show($s, $label) { Write-Output ("{0}: AllowFirmwareLoadFromFile={1}{2}; 9001 GUID {3}" -f $label,
  $(if ($null -eq $s.afl) { '<absent>' } else { $s.afl }), $(if ($s.aflKind) { " ($($s.aflKind))" } else { '' }), $(if ($s.guid) { 'present' } else { 'absent' })) }
if ((@($Status, $Apply, $Revert) | Where-Object { $_ }).Count -ne 1) { Write-Output 'usage: hvnode-m3.ps1 -Status | -Apply | -Revert'; exit 2 }
$now = Read-State
if ($Status) { Show $now 'now'; if (Test-Path $Record) { Show ((Get-Content -Raw $Record | ConvertFrom-Json)) 'recorded prior' }; exit 0 }

if ($Apply) {
  if (Test-Path $Record) { Write-Output "REFUSED: $Record exists (already applied; -Revert first, or read it)"; exit 2 }
  New-Item -ItemType Directory -Force -Path (Split-Path $Record) | Out-Null
  $prior = [ordered]@{ afl = $now.afl; aflKind = $now.aflKind; guid = $now.guid; guidAddedByApply = (-not $now.guid)
                       appliedAt = (Get-Date).ToUniversalTime().ToString('o') }
  ($prior | ConvertTo-Json) | Set-Content -Path $Record -Encoding ASCII
  Show $now 'prior (recorded)'
  Set-ItemProperty -Path $virt -Name $name -Value 1 -Type DWORD
  if (-not $now.guid) {
    New-Item -Path $svc -Force | Out-Null
    New-ItemProperty -Path $svc -Name 'ElementName' -Value 'enclave report signing (9001)' -PropertyType String -Force | Out-Null
  }
  $after = Read-State; Show $after 'after'
  if ($after.afl -ne 1 -or $after.aflKind -ne 'DWord' -or -not $after.guid) { Write-Output 'FAIL: the settings did not take (run -Revert)'; exit 1 }
  Write-Output 'M3 APPLIED (permanent until -Revert)'; exit 0
}

if ($Revert) {
  if (-not (Test-Path $Record)) { Write-Output "REFUSED: no $Record (nothing recorded to revert to)"; exit 2 }
  $prior = Get-Content -Raw $Record | ConvertFrom-Json
  if ($null -eq $prior.afl) { Remove-ItemProperty -Path $virt -Name $name -ErrorAction SilentlyContinue }
  else { Set-ItemProperty -Path $virt -Name $name -Value $prior.afl -Type $prior.aflKind }
  if ($prior.guidAddedByApply) { Remove-Item -Path $svc -Recurse -Force -ErrorAction SilentlyContinue }
  $after = Read-State; Show $after 'after revert'
  $ok = ("$($after.afl)" -eq "$($prior.afl)") -and ($after.guid -eq [bool]$prior.guid)
  if (-not $ok) { Write-Output 'FAIL: the prior state is NOT restored'; exit 1 }
  $done = "$Record.reverted-" + (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssZ')
  Move-Item -Path $Record -Destination $done
  Write-Output "M3 REVERTED to the recorded prior state (verified; record kept as $done)"; exit 0
}
