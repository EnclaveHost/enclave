# firmware-setting.tests.ps1 - uefi-dev-boot.ps1's AllowFirmwareLoadFromFile handling, against RECORDING STUBS (never a host):
# already present = 1 -> NO registry write at all (not the apply, not the restore, not the watchdog's restore) and the
# cleanup says "left as it was"; absent / present-but-0 -> apply 1, restore the exact prior state (enclave-87's ruling on
# enclave-d1's audit, 09-26). The four functions are read out of uefi-dev-boot.ps1's syntax tree (as judge-probe.tests.ps1
# does), so this tests the script's own code.
#   pwsh -NoProfile -File windows/vbslike/ops/firmware-setting.tests.ps1          exit 0 = ALL OK
param([string]$Script = (Join-Path $PSScriptRoot 'uefi-dev-boot.ps1'))
$ErrorActionPreference = 'Stop'
$tok = $null; $err = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile((Resolve-Path $Script).Path, [ref]$tok, [ref]$err)
if ($err.Count) { throw "uefi-dev-boot.ps1 does not parse: $($err[0].Message)" }
$names = 'FirmwareAlreadyOn', 'Invoke-FirmwareApply', 'Invoke-FirmwareRestore', 'FirmwareWatchdogRestore'
$src = @{}
foreach ($n in $names) {
  $f = @($ast.FindAll({ param($x) $x -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $x.Name -eq $n }, $true))
  if ($f.Count -ne 1) { throw "uefi-dev-boot.ps1 has $($f.Count) definitions of $n" }
  $src[$n] = $f[0].Extent.Text
}
$fail = 0
function Check([bool]$ok, [string]$what) { if ($ok) { Write-Output "ok   $what" } else { Write-Output "FAIL $what"; $script:fail++ } }

# the stubs: every registry write and every Note is recorded; Read-Setting answers the case's "after"
$script:calls = @(); $script:notes = @(); $script:afterState = $null
$RegPath = 'HKLM:\Software\Microsoft\Windows NT\CurrentVersion\Virtualization'; $RegName = 'AllowFirmwareLoadFromFile'
function Set-ItemProperty { param($Path, $Name, $Value, $Type) $script:calls += "Set $Name=$Value" }
function Remove-ItemProperty { param($Path, $Name, $EA) $script:calls += "Remove $Name" }
function New-ItemProperty { param($Path, $Name, $Value, $PropertyType, [switch]$Force) $script:calls += "New $Name" }
function Note($m) { $script:notes += "$m" }
function Read-Setting { $script:afterState }
# the functions' text, dot-sourced at SCRIPT scope by the caller (a dot-source inside a function would define them only there)
function LoadText([hashtable]$over = @{}) { ($names | ForEach-Object { if ($over.ContainsKey($_)) { $over[$_] } else { $src[$_] } }) -join "`n" }
function Reset($after) { $script:calls = @(); $script:notes = @(); $script:afterState = $after }
$writes = { @($script:calls | Where-Object { $_ -match '^(Set|Remove|New) ' }) }

function Suite([string]$label) {
  $present1 = @{ S = 'Present'; V = 1; K = 'DWord' }
  # 1. already present = 1 (M3's permanent state): nothing is written, and cleanup says "left as it was"
  Reset $present1
  $m = Invoke-FirmwareApply $present1 $false
  Check ($m -eq $false) "$label present=1: apply reports not mutated"
  $r = Invoke-FirmwareRestore $present1 ([bool]$m)
  Check ($null -eq $r) "$label present=1: restore verifies (no failure)"
  Check ((& $writes).Count -eq 0) "$label present=1: NO registry write (got: $((& $writes) -join '; '))"
  Check (@($script:notes | Where-Object { $_ -match 'already present' -and $_ -match 'not touched' }).Count -eq 1) "$label present=1: the apply says 'already present ... not touched'"
  Check (@($script:notes | Where-Object { $_ -match '^SETTING left as it was \(' }).Count -eq 1) "$label present=1: the cleanup says 'SETTING left as it was (...)'"
  $wd = FirmwareWatchdogRestore $present1
  Check ($wd -notmatch '(Set|Remove|New)-ItemProperty') "$label present=1: the watchdog's restore writes nothing ($wd)"
  # 2. absent (a lab host): apply 1, then remove it again, verified
  $absent = @{ S = 'Absent' }
  Reset $absent
  $m = Invoke-FirmwareApply $absent $false
  Check ($m -eq $true) "$label absent: apply reports mutated"
  Check (@($script:calls | Where-Object { $_ -eq 'Set AllowFirmwareLoadFromFile=1' }).Count -eq 1) "$label absent: applied = 1"
  $r = Invoke-FirmwareRestore $absent ([bool]$m)
  Check ($null -eq $r) "$label absent: restore verifies"
  Check (@($script:calls | Where-Object { $_ -eq 'Remove AllowFirmwareLoadFromFile' }).Count -eq 1) "$label absent: removed again"
  Check ((FirmwareWatchdogRestore $absent) -match '^Remove-ItemProperty ') "$label absent: the watchdog removes it"
  # 3. present but 0: apply 1, restore to 0
  $present0 = @{ S = 'Present'; V = 0; K = 'DWord' }
  Reset $present0
  $m = Invoke-FirmwareApply $present0 $false
  Check ($m -eq $true -and @($script:calls | Where-Object { $_ -eq 'Set AllowFirmwareLoadFromFile=1' }).Count -eq 1) "$label present=0: applied = 1"
  $r = Invoke-FirmwareRestore $present0 ([bool]$m)
  Check ($null -eq $r -and @($script:calls | Where-Object { $_ -eq 'Set AllowFirmwareLoadFromFile=0' }).Count -eq 1) "$label present=0: restored to 0"
  Check ((FirmwareWatchdogRestore $present0) -match "^Set-ItemProperty .* -Value 0 ") "$label present=0: the watchdog restores 0"
  # 4. -WithoutFirmwarePolicy on an absent host: nothing written, nothing restored
  Reset $absent
  $m = Invoke-FirmwareApply $absent $true
  $r = Invoke-FirmwareRestore $absent ([bool]$m)
  Check ($m -eq $false -and $null -eq $r -and (& $writes).Count -eq 0) "$label -WithoutFirmwarePolicy: no write"
  # 5. a restore that did not take is reported
  Reset @{ S = 'Present'; V = 1; K = 'DWord' }
  $r = Invoke-FirmwareRestore $absent $true
  Check ($r -match '^SETTING NOT RESTORED') "$label absent, restore not taken: reported ($r)"
}

. ([scriptblock]::Create((LoadText)))
Suite 'script:'
# MUTANT: the already-on check removed - the present=1 suite must catch the writes
$fail0 = $fail
. ([scriptblock]::Create((LoadText @{ FirmwareAlreadyOn = 'function FirmwareAlreadyOn($s) { $false }' })))
$out = Suite 'mutant:'
$caught = @($out | Where-Object { $_ -match '^FAIL mutant: present=1: NO registry write' }).Count -eq 1
$fail = $fail0
Check $caught 'mutant (no already-on check): the present=1 "NO registry write" assertion FAILS, as it must'

if ($fail) { Write-Output "firmware-setting tests: $fail FAILED"; exit 1 }
Write-Output 'firmware-setting tests: ALL OK'
