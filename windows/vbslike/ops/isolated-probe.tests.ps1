# isolated-probe.tests.ps1 -- the failure paths of isolated-probe.lib.ps1, with mocked inputs. No
# registry, no filesystem, no process, no host: every case here is a value handed to a pure function.
# The cases are the ones a review found, each named after the way it could go wrong silently.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File .\isolated-probe.tests.ps1
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'isolated-probe.lib.ps1')

$script:pass = 0; $script:fail = 0
function T([string] $name, [scriptblock] $body) {
  try {
    $ok = & $body
    if ($ok) { $script:pass++; Write-Host "  [PASS] $name" }
    else { $script:fail++; Write-Host "  [FAIL] $name" }
  } catch { $script:fail++; Write-Host "  [FAIL] $name -- threw: $($_.Exception.Message)" }
}

Write-Host "the setting's state: absent, present and unreadable are three answers"
T 'a value that does not exist is Absent' {
  (Resolve-SettingState -KeyExists $true -ValueRead @{ Ok = $false; Value = $null; Kind = $null; Error = 'Property AllowFirmwareLoadFromFile does not exist' }).Status -eq 'Absent'
}
T 'a read that failed for any other reason is Error, NOT Absent (it must never be "restored" by deletion)' {
  $s = Resolve-SettingState -KeyExists $true -ValueRead @{ Ok = $false; Value = $null; Kind = $null; Error = 'Requested registry access is not allowed' }
  $s.Status -eq 'Error' -and $s.Error -match 'not allowed'
}
T 'a key that will not open is Error' { (Resolve-SettingState -KeyExists $false -ValueRead $null).Status -eq 'Error' }
T 'no read attempted is Error' { (Resolve-SettingState -KeyExists $true -ValueRead $null).Status -eq 'Error' }
T 'a present value carries its type' {
  $s = Resolve-SettingState -KeyExists $true -ValueRead @{ Ok = $true; Value = 1; Kind = 'DWord'; Error = $null }
  $s.Status -eq 'Present' -and $s.Value -eq 1 -and $s.Kind -eq 'DWord'
}

Write-Host "restoration is status, value AND registry type"
$absent = [pscustomobject]@{ Status = 'Absent'; Value = $null; Kind = $null; Error = $null }
$dword1 = [pscustomobject]@{ Status = 'Present'; Value = 1; Kind = 'DWord'; Error = $null }
T 'absent restored to absent' { Test-SettingRestored -Before $absent -Now $absent }
T 'absent left present is NOT restored' { -not (Test-SettingRestored -Before $absent -Now $dword1) }
T 'a value restored as the wrong TYPE is not restored' {
  -not (Test-SettingRestored -Before $dword1 -Now ([pscustomobject]@{ Status = 'Present'; Value = 1; Kind = 'String'; Error = $null }))
}
T 'a value restored to the wrong number is not restored' {
  -not (Test-SettingRestored -Before $dword1 -Now ([pscustomobject]@{ Status = 'Present'; Value = 0; Kind = 'DWord'; Error = $null }))
}
T 'an Error state is never reported as restored' {
  -not (Test-SettingRestored -Before ([pscustomobject]@{ Status = 'Error'; Value = $null; Kind = $null; Error = 'x' }) -Now $absent)
}

Write-Host "image access: an ACE is not permission"
T 'an Allow ACE granting Read passes' {
  (Test-ImageReadAccess -Aces @(@{ Identity = 'NT VIRTUAL MACHINE\Virtual Machines'; Type = 'Allow'; Rights = 'Read, Synchronize' })).Ok
}
T 'no ACE at all fails' { -not (Test-ImageReadAccess -Aces @(@{ Identity = 'BUILTIN\Administrators'; Type = 'Allow'; Rights = 'FullControl' })).Ok }
T 'a DENY ACE for the VM worker fails even beside an Allow' {
  -not (Test-ImageReadAccess -Aces @(
    @{ Identity = 'NT VIRTUAL MACHINE\Virtual Machines'; Type = 'Allow'; Rights = 'Read' },
    @{ Identity = 'NT VIRTUAL MACHINE\Virtual Machines'; Type = 'Deny'; Rights = 'Read' })).Ok
}
T 'an Allow ACE that grants something other than read fails' {
  -not (Test-ImageReadAccess -Aces @(@{ Identity = 'NT VIRTUAL MACHINE\Virtual Machines'; Type = 'Allow'; Rights = 'WriteAttributes, Synchronize' })).Ok
}
T 'the SID form of the identity is recognised' {
  (Test-ImageReadAccess -Aces @(@{ Identity = 'S-1-5-83-0'; Type = 'Allow'; Rights = 'ReadAndExecute, Synchronize' })).Ok
}

Write-Host "the launcher's probe: a broken probe is a failure, never 'zero partitions'"
$good = '{"hcs":{"HcsEnumerateComputeSystems":{"ok":true,"result":[]}}}'
T 'a clean empty enumeration is Ok with no systems' {
  # @() around the property: an empty collection read back off a PSCustomObject can unroll to nothing,
  # and the assertion is about the count, not about PowerShell's unrolling
  $r = Read-ProbeResult -ExitCode 0 -Output $good; $r.Ok -and @($r.Systems).Count -eq 0
}
T 'a non-zero exit is NOT ok' { -not (Read-ProbeResult -ExitCode 1 -Output $good).Ok }
T 'empty output is NOT ok' { -not (Read-ProbeResult -ExitCode 0 -Output '').Ok }
T 'malformed JSON is NOT ok' { -not (Read-ProbeResult -ExitCode 0 -Output 'CreateEnclave failed: 0x80070005').Ok }
T 'JSON without the enumeration result is NOT ok' { -not (Read-ProbeResult -ExitCode 0 -Output '{"hcs":{}}').Ok }
T 'an enumeration that reported failure is NOT ok' {
  -not (Read-ProbeResult -ExitCode 0 -Output '{"hcs":{"HcsEnumerateComputeSystems":{"ok":false,"error":"x"}}}').Ok
}
T 'ok with no result array is NOT ok' {
  -not (Read-ProbeResult -ExitCode 0 -Output '{"hcs":{"HcsEnumerateComputeSystems":{"ok":true}}}').Ok
}
T 'an entry missing Id or Owner is refused rather than interpreted' {
  -not (Read-ProbeResult -ExitCode 0 -Output '{"hcs":{"HcsEnumerateComputeSystems":{"ok":true,"result":[{"Id":"x"}]}}}').Ok
}
T 'existing lab partitions are seen (so the preflight can refuse)' {
  $r = Read-ProbeResult -ExitCode 0 -Output '{"hcs":{"HcsEnumerateComputeSystems":{"ok":true,"result":[{"Id":"vbslike-iso-1-0","Owner":"vbslike"}]}}}'
  $r.Ok -and @(Select-OwnedSystems -Systems $r.Systems).Count -eq 1
}

T 'an entry whose Id is present but empty is refused' {
  -not (Read-ProbeResult -ExitCode 0 -Output '{"hcs":{"HcsEnumerateComputeSystems":{"ok":true,"result":[{"Id":"","Owner":"vbslike"}]}}}').Ok
}
T 'a JSON entry whose Owner is absent does not throw, it is refused' {
  -not (Read-ProbeResult -ExitCode 0 -Output '{"hcs":{"HcsEnumerateComputeSystems":{"ok":true,"result":[{"Id":"x","Other":1}]}}}').Ok
}

Write-Host "cleanup candidates: this run's partitions, and nothing else"
$mixed = @(
  @{ Id = 'vbslike-iso-4242-0'; Owner = 'vbslike' },      # this run
  @{ Id = 'vbslike-iso-9999-0'; Owner = 'vbslike' },      # another run of ours
  @{ Id = 'someone-elses-vm';   Owner = 'hcsshim' },      # not ours at all
  @{ Id = 'vbslike-iso-4242-1'; Owner = 'hcsshim' }       # our name, not our owner
)
T 'only this run''s prefix AND our owner is a candidate' {
  $sel = @(Select-OwnedSystems -Systems $mixed -IdPrefix 'vbslike-iso-4242-')
  $sel.Count -eq 1 -and $sel[0].Id -eq 'vbslike-iso-4242-0'
}
T 'a foreign VM is never a candidate, whatever its id' {
  @(Select-OwnedSystems -Systems $mixed -IdPrefix 'someone-elses').Count -eq 0
}
T 'without a prefix, ownership alone still excludes foreign systems' {
  @(Select-OwnedSystems -Systems $mixed).Count -eq 2
}

Write-Host ""
Write-Host "$script:pass passed, $script:fail failed"
if ($script:fail -gt 0) { exit 1 }
exit 0
