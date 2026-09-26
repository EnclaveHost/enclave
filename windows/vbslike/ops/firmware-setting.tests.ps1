# firmware-setting.tests.ps1 - uefi-dev-boot.ps1's AllowFirmwareLoadFromFile handling, against RECORDING STUBS (never a host):
# Read-Setting is FAIL-CLOSED: Absent only for value-not-found, NoKey only for path-not-found, anything else Unreadable, which
# REFUSES the run before any write (enclave-bf's review of 55019552: a transient error read as Absent removed the setting).
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
$names = 'Read-Setting', 'FirmwareAlreadyOn', 'Assert-FirmwareRunnable', 'Invoke-FirmwareApply', 'Invoke-FirmwareRestore', 'FirmwareWatchdogRestore'
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

# ---- Read-Setting, FAIL-CLOSED (enclave-bf's review of 55019552), against a stubbed Get-Item ----
$script:getItem = $null
function Get-Item { param($LiteralPath, $ErrorAction) & $script:getItem }
function FakeKey([string[]]$names, $value = 1, [bool]$kindThrows = $false, [bool]$namesThrow = $false) {
  $o = [pscustomobject]@{ n = $names; v = $value; kt = $kindThrows; nt = $namesThrow }
  $o | Add-Member -MemberType ScriptMethod -Name GetValueNames -Value { if ($this.nt) { throw [System.IO.IOException]::new('transient read error') }; $this.n }
  $o | Add-Member -MemberType ScriptMethod -Name GetValue -Value { param($x) $this.v }
  $o | Add-Member -MemberType ScriptMethod -Name GetValueKind -Value { param($x) if ($this.kt) { throw [System.UnauthorizedAccessException]::new('kind: access denied') }; 'DWord' }
  $o
}
function ReadGroup([string]$label) {
  $script:getItem = { throw [System.Management.Automation.ItemNotFoundException]::new('Cannot find path') }
  Check ((Read-Setting).S -eq 'NoKey') "$label key missing (path not found) -> NoKey"
  $script:getItem = { throw [System.UnauthorizedAccessException]::new('Requested registry access is not allowed.') }
  Check ((Read-Setting).S -eq 'Unreadable') "$label access denied -> Unreadable (never Absent)"
  $script:getItem = { FakeKey @('Other') }
  Check ((Read-Setting).S -eq 'Absent') "$label key present, value absent -> Absent"
  $script:getItem = { FakeKey @('AllowFirmwareLoadFromFile') 1 }
  $s = Read-Setting
  Check ($s.S -eq 'Present' -and "$($s.V)" -eq '1' -and $s.K -eq 'DWord') "$label value present = 1 -> Present 1 DWord"
  $script:getItem = { FakeKey @('AllowFirmwareLoadFromFile') 1 $true }
  Check ((Read-Setting).S -eq 'Unreadable') "$label GetValueKind throws -> Unreadable"
  $script:getItem = { FakeKey @('AllowFirmwareLoadFromFile') 1 $false $true }
  Check ((Read-Setting).S -eq 'Unreadable') "$label GetValueNames throws (transient) -> Unreadable"
}
ReadGroup 'read:'

# bf's scenario, end to end: production Present = 1, ONE transient access-denied read at the start -> refused before any write
Reset $null
$script:getItem = { throw [System.UnauthorizedAccessException]::new('Requested registry access is not allowed.') }
$b = Read-Setting
$threw = $false; try { Assert-FirmwareRunnable $b $false } catch { $threw = $true }
Check ($b.S -eq 'Unreadable' -and $threw -and (& $writes).Count -eq 0) 'bf scenario: an unreadable setting REFUSES the run before any write (no apply, no restore)'
# ... and a transient error only at the AFTER read is NOT verified (never "restored")
Reset $null
$script:getItem = { throw [System.UnauthorizedAccessException]::new('Requested registry access is not allowed.') }
$r = Invoke-FirmwareRestore @{ S = 'Present'; V = 1; K = 'DWord' } $false
Check ($r -match '^SETTING NOT VERIFIED' -and (& $writes).Count -eq 0) "after-read unreadable: NOT VERIFIED, no write ($r)"
# Assert-FirmwareRunnable: -WithoutFirmwarePolicy with the setting already on is refused; otherwise it passes
$t1 = $false; try { Assert-FirmwareRunnable @{ S = 'Present'; V = 1 } $true } catch { $t1 = $true }
$t2 = $true; try { Assert-FirmwareRunnable @{ S = 'Absent' } $true; $t2 = $false } catch { }
$t3 = $true; try { Assert-FirmwareRunnable @{ S = 'Present'; V = 1 } $false; $t3 = $false } catch { }
Check ($t1 -and -not $t2 -and -not $t3) 'assert: -WithoutFirmwarePolicy refused when already on; allowed when absent; a normal run on Present=1 passes'

# the suites below use a Read-Setting stub (the scripted "after" state), defined after the real one so it wins
function Read-Setting { $script:afterState }
Suite 'script:'

# MUTANT: the already-on check removed - the present=1 suite must catch the writes
$fail0 = $fail
. ([scriptblock]::Create((LoadText @{ FirmwareAlreadyOn = 'function FirmwareAlreadyOn($s) { $false }' })))
$out = Suite 'mutant:'
$caught = @($out | Where-Object { $_ -match '^FAIL mutant: present=1: NO registry write' }).Count -eq 1
$fail = $fail0
Check $caught 'mutant (no already-on check): the present=1 "NO registry write" assertion FAILS, as it must'
# MUTANT 2 (enclave-bf): the OLD catch-all Read-Setting (any error -> Absent). The read group must catch it.
$fail0 = $fail
$old = @'
function Read-Setting {
  if (-not (Test-Path $RegPath)) { return @{ S='NoKey' } }
  try { $i = Get-ItemProperty $RegPath -Name $RegName -EA Stop
        @{ S='Present'; V=$i.$RegName; K="$((Get-Item $RegPath).GetValueKind($RegName))" } }
  catch { @{ S='Absent' } }
}
'@
function Test-Path { param($p) $true }
function Get-ItemProperty { param($Path, $Name, $EA) throw [System.UnauthorizedAccessException]::new('Requested registry access is not allowed.') }
. ([scriptblock]::Create($old))
$out2 = ReadGroup 'mutant2:'
$caught2 = @($out2 | Where-Object { $_ -match '^FAIL mutant2: access denied -> Unreadable' }).Count -eq 1
$fail = $fail0
Check $caught2 'mutant 2 (the old catch-all Read-Setting): "access denied -> Unreadable" FAILS, as it must'

if ($fail) { Write-Output "firmware-setting tests: $fail FAILED"; exit 1 }
Write-Output 'firmware-setting tests: ALL OK'
