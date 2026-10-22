# installer-r5-native FIXTURE (ROOT-ONLY; Windows PowerShell 5.1). Validates the proposed install-host r5 1d1580c8 /
# update-host r5 36f9e0d6 against the frozen r4 controls f19dbc19 / a2ba7b3b. It NEVER runs a real installer or updater and
# reads or changes NO production entity: no task, process, service, VM, network or config is queried, started, stopped or edited.
#   * NATIVE INTERPRETER evidence (real Windows PowerShell 5.1, real child powershell.exe, real files/ACLs INSIDE this stage):
#     - the 5.1 parser on all 4 scripts + the stand-in + this fixture;
#     - the updater's EXACT Install function (AST-extracted) running the harmless stand-in fakebundle\install-host.ps1, which
#       writes one stderr line and exits 7: r5 must return 7; the r4 control is expected to throw (the PS 5.1 merged-stderr
#       rule under "Stop"); whether the stand-in still completes is recorded;
#     - the installer's exact Test-PrivateDir on a protected fixture dir, its exact install-status.json write/read (BOM) and
#       its exact Get-ReleaseDependency reading real fixture wrapper scripts and expanding real %ProgramFiles%.
#   * MOCKED TASK SEMANTICS (control flow on the native interpreter only): Task Scheduler, process lists and every
#     start/stop/kill are in-memory mocks recording events; Stop-ForInstall / Restore-OtherTasks are the exact r5/r4 functions.
# Every mutating or live-reading cmdlet is a TRIPWIRE (throws). Files are written only below -Stage (checked path prefix).
#   native-test.ps1 -Stage <dir>                      main: pins, parse, 6 bounded child parts, one JSON line; exit 0 = pass
#   native-test.ps1 -Stage <dir> -Part <p> -Source <f>  one child part (run by main)
#   -LocalSmoke: Linux pwsh harness only (the driver never passes it): Windows-only checks are reported SKIPPED, not passed.
param([string]$Stage, [string]$Part = "", [string]$Source = "", [switch]$LocalSmoke)
$ErrorActionPreference = 'Stop'; $ProgressPreference = 'SilentlyContinue'
$CHILD_MS = 90000; $FIXTURE_SEC = 600; $EXPECT_CODE = 7
$PIN = [ordered]@{ 'install-host.r5.ps1' = '1d1580c8f9ac22f6ec96a34cea8455853b21a21cff5214187710f3483953b721'
  'update-host.r5.ps1' = '36f9e0d61afe58b77e566033ad1155d5c771252874f622592837c33e0a990112'
  'install-host.r4.ps1' = 'f19dbc19ae19a698c7ded64b1023a502af3e627694728f4bb741407a091b5620'
  'update-host.r4.ps1' = 'a2ba7b3bb4256d8a049fec84086da45517bfe0c42e2b623aabd18aeb7070a79c'
  'fakebundle\install-host.ps1' = '7ccda0fb9eccbf317f1497a73de94adb65ae549aa61672c4c9c0c6633e9333d2' }
$SEP = [IO.Path]::DirectorySeparatorChar
function StagePath([string]$rel) { Join-Path $Stage ($rel.Replace('\', [string]$SEP)) }
function FileSha256($p) { if (Test-Path -LiteralPath $p) { (Get-FileHash -Algorithm SHA256 -LiteralPath $p).Hash.ToLower() } else { 'absent' } }
$out = [ordered]@{ pass = $false; part = $Part; source = $Source; localSmoke = [bool]$LocalSmoke }
trap { $out.pass = $false; $out.error = 'fixture error: ' + $_.Exception.Message; $out | ConvertTo-Json -Compress -Depth 8; exit 3 }

# ---------------------------------------------------------------- tripwires: nothing live and nothing mutating can run here
$FORBIDDEN = @('Get-CimInstance','Get-WmiObject','Get-NetTCPConnection','Invoke-RestMethod','Invoke-WebRequest','Get-ScheduledTask','Get-ScheduledTaskInfo',
  'Start-ScheduledTask','Stop-ScheduledTask','Enable-ScheduledTask','Disable-ScheduledTask','Set-ScheduledTask','Register-ScheduledTask','Unregister-ScheduledTask',
  'Stop-Process','Start-Process','Get-VM','Start-VM','Stop-VM','Restart-Service','Stop-Service','Start-Service','Restart-Computer','Set-Acl',
  'Set-Content','Add-Content','Out-File','Remove-Item','New-Item','Move-Item','Copy-Item','Rename-Item','Set-ItemProperty','New-ItemProperty')
foreach ($n in $FORBIDDEN) { . ([scriptblock]::Create("function $n { throw 'TRIPWIRE: $n is forbidden in the installer-r5-native fixture' }")) }
$ROOTFULL = [IO.Path]::GetFullPath($Stage).TrimEnd($SEP)
function InFixture([string]$p) {
  $f = [IO.Path]::GetFullPath($p); if (-not $f.StartsWith($ROOTFULL + $SEP, [StringComparison]::OrdinalIgnoreCase)) { throw "TRIPWIRE: write outside the stage: $f" }; $f }
function FxDir([string]$p, [switch]$Private) {
  $f = InFixture $p
  if ($Private -and -not $LocalSmoke) {
    $ds = New-Object Security.AccessControl.DirectorySecurity; $ds.SetSecurityDescriptorSddlForm('O:BAD:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)')   # owner BA explicit: needs the elevated admin ssh token
    [void][IO.Directory]::CreateDirectory($f, $ds) } else { [void][IO.Directory]::CreateDirectory($f) }
  $f }
# the ONE writer the extracted code may use (Save-InstallStatus): real Set-Content, fixture paths only
function Set-Content { [CmdletBinding()] param([Parameter(Position = 0)][string]$Path, [string]$LiteralPath, [string]$Encoding = 'UTF8', [Parameter(ValueFromPipeline = $true)]$Value)
  begin { $all = @() } process { $all += $Value }
  end { $t = $(if ($LiteralPath) { $LiteralPath } else { $Path }); Microsoft.PowerShell.Management\Set-Content -LiteralPath (InFixture $t) -Encoding $Encoding -Value $all } }
function WriteFx([string]$p, [string]$text) { [IO.File]::WriteAllText((InFixture $p), $text) }

# ================================================================ CHILD PARTS
if ($Part) {
  if ($PIN.Keys -notcontains $Source) { throw "unknown source $Source" }
  foreach ($k in @($Source, 'fakebundle\install-host.ps1')) { if ((FileSha256 (StagePath $k)) -ne $PIN[$k]) { throw "staged $k is not its pin" } }
  $rev = $(if ($Source -like '*.r5.ps1') { 'r5' } else { 'r4' })
  $FX = FxDir (StagePath "fx-$Part-$rev")
  $tk = $null; $er = $null; $AST = [Management.Automation.Language.Parser]::ParseFile((StagePath $Source), [ref]$tk, [ref]$er)
  if ($er.Count) { throw "parse errors in $Source" }
  $WANT = @{ install = @('Install'); pending = @('Test-ReleaseOwned', 'Test-ReleaseRef', 'Get-ReleaseDependency', 'Test-PrivateDir', 'Save-InstallStatus', 'Stop-ForInstall', 'Restore-OtherTasks', 'Get-EarlierPending')
             wrapper = @('Test-ReleaseOwned', 'Test-ReleaseRef', 'Get-ReleaseDependency') }[$Part]
  if (-not $WANT) { throw "unknown part $Part" }
  $missing = @()
  # exact function text from the pinned source, defined at SCRIPT scope (dot-sourced here, never inside a function)
  foreach ($name in $WANT) {
    $f = @($AST.FindAll({ param($a) $a -is [Management.Automation.Language.FunctionDefinitionAst] -and $a.Name -eq $name }, $true))
    if ($f.Count -eq 0) { $missing += $name; continue }; if ($f.Count -gt 1) { throw "function $name duplicated" }
    . ([scriptblock]::Create($f[0].Extent.Text)) }
  $out.missingFunctions = $missing
  if ($Part -ne 'install') {   # the source's own script-scope lists (assignment lines only; never a line that calls a Get- function)
    foreach ($line in ([IO.File]::ReadAllText((StagePath $Source)) -split "`n")) { if ($line -match '^\$script:\w+ = ' -and $line -notmatch '\(Get-') { . ([scriptblock]::Create($line)) } } }

  if ($Part -eq 'install') {
    if ($missing.Count) { throw "Install missing from $Source" }
    $script:LogLines = New-Object Collections.Generic.List[string]
    function Log($m) { $script:LogLines.Add([string]$m) }          # the updater's Log writes update.log; here: memory only
    $dir = StagePath 'fakebundle'; $marker = Join-Path $FX 'child-completed.txt'
    if ((FileSha256 (Join-Path $dir 'install-host.ps1')) -ne $PIN['fakebundle\install-host.ps1']) { throw 'stand-in is not pinned' }
    $sw = [Diagnostics.Stopwatch]::StartNew()
    try { $code = Install $dir 'fixture-host' 'fixture-owner' $marker; $out.threw = $false; $out.code = $code }
    catch { $out.threw = $true; $out.errorType = $_.Exception.GetType().FullName; $out.errorMessage = ([string]$_.Exception.Message).Substring(0, [math]::Min(200, ([string]$_.Exception.Message).Length)) }
    $out.installSec = [math]::Round($sw.Elapsed.TotalSeconds, 1)
    $deadline = (Get-Date).AddSeconds(10); while (-not (Test-Path -LiteralPath $marker) -and (Get-Date) -lt $deadline) { [Threading.Thread]::Sleep(250) }
    $out.childCompleted = (Test-Path -LiteralPath $marker)
    $out.logLines = @($script:LogLines | Select-Object -First 20 | ForEach-Object { $_.Substring(0, [math]::Min(200, $_.Length)) })
    $out.stdoutLogged = [bool]@($script:LogLines | Where-Object { $_ -match 'fake-installer: start' }).Count
    $out.stderrLogged = [bool]@($script:LogLines | Where-Object { $_ -match 'fake-installer: stderr' }).Count
    $out.pass = $true
  }
  elseif ($Part -eq 'pending') {
    foreach ($n in $missing) { if ($n -ne 'Get-EarlierPending' -or $rev -eq 'r5') { throw "$n missing from $Source" } }
    $PF = FxDir (Join-Path $FX 'PF'); $PD = FxDir (Join-Path $FX 'PD'); $logs = FxDir (Join-Path $PD 'logs') -Private; $manifest = $null
    $out.privateDirNative = $(if ($LocalSmoke) { 'SKIPPED (not Windows)' } else { [bool](Test-PrivateDir $logs) })
    if (-not $LocalSmoke) { $acl = Get-Acl -LiteralPath $logs; $out.logsOwner = $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value; $out.logsProtected = $acl.AreAccessRulesProtected }
    else { function Test-PrivateDir($dir) { [IO.Path]::GetFullPath($dir) -eq $logs } }   # Linux: no Windows ACLs (reported SKIPPED above)
    # the earlier install's record: Relay and OpDisabled were stopped by it and left PENDING; hs2 was never stopped
    $seed = [ordered]@{ at = '2026-10-22T02:00:00Z'; result = 'RECOVERY-REQUIRED'; detail = 'failed; not running again: Relay, OpDisabled'; updating = $true
      bundleVersion = '2026.10.22'; otherRolesRestored = $false; roles = [ordered]@{
        Relay = [ordered]@{ enabled = $true; running = $true; stopped = $true; why = 'process 301 runs a release file'; outcome = 'PENDING: scheduler denied start' }
        OpDisabled = [ordered]@{ enabled = $true; running = $true; stopped = $true; why = 'its task action names a release file'; outcome = 'PENDING: not yet restarted' }
        'enclave-host-services-hs2' = [ordered]@{ enabled = $true; running = $true; stopped = $false; why = $null; outcome = $null } } }
    $seed | ConvertTo-Json -Depth 5 | Set-Content -Encoding UTF8 (Join-Path $logs 'install-status.json')
    # ---- MOCKED Task Scheduler / processes (in memory, events recorded; nothing real is touched)
    $script:Ev = New-Object Collections.Generic.List[string]; $script:Emits = New-Object Collections.Generic.List[string]
    function Emit($step, $state, $message) { $script:Emits.Add("$step|$state|$message") }
    function MockTask($name, $state, $enabled, $exe) { [pscustomobject]@{ TaskName = $name; State = $state; Settings = [pscustomobject]@{ Enabled = $enabled }
      Actions = @([pscustomobject]@{ Execute = $exe; Arguments = ''; WorkingDirectory = '' }) } }
    $script:T = [ordered]@{ Shield = (MockTask 'Shield' 'Running' $true 'cmd.exe'); Update = (MockTask 'Update' 'Ready' $true 'powershell.exe')
      Relay = (MockTask 'Relay' 'Ready' $true 'cmd.exe'); OpDisabled = (MockTask 'OpDisabled' 'Ready' $false 'cmd.exe')
      'enclave-host-services-hs2' = (MockTask 'enclave-host-services-hs2' 'Running' $true 'C:\Program Files\Enclave\host-services\hs2\bin\hostsvc-supervisor.exe') }
    function Get-ScheduledTask { param($TaskPath, $TaskName, $ErrorAction) if ($TaskName) { if ($script:T.Contains($TaskName)) { $script:T[$TaskName] } else { throw "no task $TaskName" } } else { @($script:T.Values) } }
    function Stop-ScheduledTask { param($TaskPath, $TaskName, $ErrorAction) $script:Ev.Add("stop $TaskName"); if ($script:T.Contains($TaskName)) { $script:T[$TaskName].State = 'Ready' } }
    function Start-ScheduledTask { param($TaskPath, $TaskName, $ErrorAction) $t = $script:T[$TaskName]; if (-not $t.Settings.Enabled) { $script:Ev.Add("start-refused-disabled $TaskName"); return }; $script:Ev.Add("start $TaskName"); $t.State = 'Running' }
    function Get-RunningTaskTrees { @{ 'enclave-host-services-hs2' = @([pscustomobject]@{ pid = 101; created = 'c101'; exe = 'C:\Program Files\nodejs\node.exe'
      cmd = '"C:\Program Files\nodejs\node.exe" "C:\Program Files\Enclave\host-services\hs2\bin\host-services-runner.mjs"' }) } }
    function Get-CimInstance { param($ClassName) @() }
    function Stop-Process { param($Id, [switch]$Force, $ErrorAction) $script:Ev.Add("kill $Id") }
    function Start-Sleep { param($Seconds, $Milliseconds) }
    $out.hasEarlierPending = [bool](Get-Command Get-EarlierPending -CommandType Function -ErrorAction SilentlyContinue)
    if ($out.hasEarlierPending) { $script:EarlierPending = @(Get-EarlierPending) }
    $out.earlierPending = @($script:EarlierPending)
    $null = Stop-ForInstall
    $null = Restore-OtherTasks "during the native fixture"
    $sf = Join-Path $logs 'install-status.json'; $bytes = [IO.File]::ReadAllBytes($sf)
    $out.statusBom = (($bytes[0..2] | ForEach-Object { $_.ToString('x2') }) -join '')
    $st = Get-Content -LiteralPath $sf -Raw | ConvertFrom-Json
    $out.statusResult = [string]$st.result
    $out.roles = [ordered]@{}; foreach ($n in 'Relay', 'OpDisabled', 'enclave-host-services-hs2') { $r = $st.roles.$n; $out.roles[$n] = $(if ($r) { [ordered]@{ stopped = $r.stopped; outcome = $r.outcome } } else { $null }) }
    $out.events = @($script:Ev); $out.stoppedOthers = @($script:StoppedOthers); $out.othersRestored = $script:OthersRestored
    $out.pass = $true
  }
  else {   # wrapper
    if ($missing.Count) { throw "missing $($missing -join ',') from $Source" }
    if ($LocalSmoke -and -not $env:ProgramFiles) { $env:ProgramFiles = 'C:\Program Files' }   # Linux has no %ProgramFiles%
    $PF = $env:ProgramFiles.TrimEnd('\') + '\Enclave'   # TEXT ONLY (no Join-Path: no drive lookup); Test-ReleaseRef/Test-ReleaseOwned never touch it
    $ext = 'C:\Program Files\nodejs\node.exe'
    WriteFx (Join-Path $FX 'dep.ps1') "& '$ext' '$PF\network\agent.mjs'`r`n"
    WriteFx (Join-Path $FX 'envdep.cmd') "@echo off`r`n`"$ext`" `"%ProgramFiles%\Enclave\control\checker.mjs`"`r`n"
    WriteFx (Join-Path $FX 'own.cmd') "@echo off`r`n`"$ext`" `"%ProgramFiles%\Enclave\host-services\hs2\main.mjs`"`r`n"
    function task($exe, $a, $wd) { [pscustomobject]@{ Actions = @([pscustomobject]@{ Execute = $exe; Arguments = $a; WorkingDirectory = $wd }) } }
    $own = @([pscustomobject]@{ pid = 101; created = 'c101'; exe = $ext; cmd = "`"$ext`" `"$PF\host-services\hs2\main.mjs`"" })
    $out.programFiles = $env:ProgramFiles
    $out.singleQuoted = Get-ReleaseDependency (task 'powershell.exe' "-NoProfile -Command `"& '$(Join-Path $FX 'dep.ps1')'`"" '') $own
    $out.envVar = Get-ReleaseDependency (task 'cmd.exe' "/c `"$(Join-Path $FX 'envdep.cmd')`"" '') $own
    $out.ownSource = Get-ReleaseDependency (task 'cmd.exe' "/c `"$(Join-Path $FX 'own.cmd')`"" '') $own
    $out.hs2 = Get-ReleaseDependency (task "$PF\host-services\hs2\bin\hostsvc-supervisor.exe" '--config C:\ProgramData\Enclave\host-services\hs2\config\supervisor.json' "$PF\host-services\hs2") $own
    $out.pass = $true
  }
  $out | ConvertTo-Json -Compress -Depth 8; exit 0
}

# ================================================================ MAIN
$Fixture = [Diagnostics.Stopwatch]::StartNew()
$out.mode = $(if ($LocalSmoke) { 'LOCAL SMOKE (Linux pwsh; Windows-only checks SKIPPED; not native evidence)' } else { 'native' })
$pins = [ordered]@{}; foreach ($k in $PIN.Keys) { $pins[$k] = ((FileSha256 (StagePath $k)) -eq $PIN[$k]) }; $out.pins = $pins
if (@($pins.Values | Where-Object { -not $_ }).Count) { $out.error = 'staged bytes are not the pinned files'; $out | ConvertTo-Json -Compress -Depth 6; exit 3 }
$parse = [ordered]@{}
foreach ($k in @($PIN.Keys) + 'native-test.ps1') { $tk = $null; $er = $null; [void][Management.Automation.Language.Parser]::ParseFile((StagePath $k), [ref]$tk, [ref]$er); $parse[$k] = $er.Count }
$out.parseErrors = $parse; $out.psVersion = $PSVersionTable.PSVersion.ToString(); $out.psEdition = [string]$PSVersionTable.PSEdition
if (-not $LocalSmoke -and ($PSVersionTable.PSVersion.Major -ne 5 -or [string]$PSVersionTable.PSEdition -ne 'Desktop')) {
  $out.error = 'not Windows PowerShell 5.1 Desktop: this is not native evidence'; $out | ConvertTo-Json -Compress -Depth 6; exit 4 }
$exe = $(if ($LocalSmoke) { (Get-Process -Id $PID).Path } else { Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe' })
$runs = [ordered]@{}
foreach ($pp in @(@('install', 'update-host.r5.ps1'), @('install', 'update-host.r4.ps1'), @('pending', 'install-host.r5.ps1'), @('pending', 'install-host.r4.ps1'),
                  @('wrapper', 'install-host.r5.ps1'), @('wrapper', 'install-host.r4.ps1'))) {
  $key = "$($pp[0]).$(if ($pp[1] -like '*.r5.ps1') { 'r5' } else { 'r4' })"
  if ($Fixture.Elapsed.TotalSeconds + $CHILD_MS / 1000 -gt $FIXTURE_SEC) { $runs[$key] = [ordered]@{ error = "fixture bound $FIXTURE_SEC s" }; continue }
  # own child only (a .NET process object, not Start-Process); killed only if it overruns its own bound
  $si = New-Object Diagnostics.ProcessStartInfo $exe
  $si.Arguments = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$PSCommandPath`" -Stage `"$Stage`" -Part $($pp[0]) -Source $($pp[1])" + $(if ($LocalSmoke) { ' -LocalSmoke' } else { '' })
  $si.UseShellExecute = $false; $si.RedirectStandardOutput = $true; $si.RedirectStandardError = $true; $si.CreateNoWindow = $true
  $p = [Diagnostics.Process]::Start($si); $so = $p.StandardOutput.ReadToEndAsync(); $se = $p.StandardError.ReadToEndAsync()
  $r = [ordered]@{ timedOut = $false }
  if (-not $p.WaitForExit($CHILD_MS)) { $r.timedOut = $true; try { $p.Kill() } catch { }; [void]$p.WaitForExit(10000) }
  $r.exit = $(if ($p.HasExited) { $p.ExitCode } else { $null })
  $lines = @(([string]$so.Result) -split "`r?`n" | Where-Object { $_.Trim() }); $r.stderrTail = ([string]$se.Result).Trim(); if ($r.stderrTail.Length -gt 400) { $r.stderrTail = $r.stderrTail.Substring($r.stderrTail.Length - 400) }
  try { $r.result = ($lines | Select-Object -Last 1) | ConvertFrom-Json } catch { $r.result = $null; $r.unparsed = ($lines | Select-Object -Last 3) -join ' | ' }
  $runs[$key] = $r }
$out.children = $runs
# ---------------------------------------------------------------- grading: [name, ok, windowsOnly, evidence]
function Res($k) { $runs[$k].result }   # not 'R': that is the built-in alias of Invoke-History
function Ok($k) { $x = $runs[$k]; (-not $x.timedOut) -and $x.exit -eq 0 -and $x.result -and $x.result.pass -eq $true }
function Rel($v) { ([string]$v) -match 'names a release file' }
$NI = 'native-interpreter'; $MT = 'mocked-task-semantics'
$checks = @(
  ,@('parse: all 6 files 0 errors (Windows PowerShell 5.1 parser)', (@($parse.Values | Where-Object { $_ -ne 0 }).Count -eq 0), $false, $NI)
  ,@('children: all 6 parts exited 0 within their bound with a result', (@($runs.Keys | Where-Object { -not (Ok $_) }).Count -eq 0), $false, $NI)
  ,@('install.r5: exact Install returns the stand-in exit code 7 (no throw)', ((Ok 'install.r5') -and (Res 'install.r5').threw -eq $false -and (Res 'install.r5').code -eq $EXPECT_CODE), $false, $NI)
  ,@('install.r5: the stand-in stdout AND stderr lines reach the log', ((Ok 'install.r5') -and (Res 'install.r5').stdoutLogged -and (Res 'install.r5').stderrLogged), $false, $NI)
  ,@('install.r5: the stand-in ran to completion (marker written)', ((Ok 'install.r5') -and (Res 'install.r5').childCompleted -eq $true), $false, $NI)
  ,@('install.r4 CONTROL: exact r4 Install THROWS under Stop on the stderr line (IR-3 reproduced)', ((Ok 'install.r4') -and (Res 'install.r4').threw -eq $true), $true, $NI)
  ,@('pending.r5: earlier install-status.json PENDING roles read (Relay, OpDisabled)', ((Ok 'pending.r5') -and @((Res 'pending.r5').earlierPending) -contains 'Relay' -and @((Res 'pending.r5').earlierPending) -contains 'OpDisabled'), $false, $MT)
  ,@('pending.r5: Relay started exactly once, OpDisabled never, hs2 untouched', ((Ok 'pending.r5') -and @((Res 'pending.r5').events | Where-Object { $_ -eq 'start Relay' }).Count -eq 1 -and
      -not (@((Res 'pending.r5').events) -match 'OpDisabled|enclave-host-services-hs2')), $false, $MT)
  ,@('pending.r5: status rewritten: Relay running, OpDisabled operator-disabled', ((Ok 'pending.r5') -and (Res 'pending.r5').roles.Relay.outcome -eq 'running' -and (Res 'pending.r5').roles.OpDisabled.outcome -eq 'operator-disabled'), $false, $MT)
  ,@('pending.r5: exact Test-PrivateDir accepts a protected SY/BA fixture dir (native ACL)', ((Ok 'pending.r5') -and (Res 'pending.r5').privateDirNative -eq $true), $true, $NI)
  ,@('pending.r4 CONTROL: r4 does not restart the earlier-PENDING Relay (IR-1 reproduced)', ((Ok 'pending.r4') -and -not (@((Res 'pending.r4').events) -contains 'start Relay')), $false, $MT)
  ,@('wrapper.r5: quoted -Command "& ''C:\...ps1''" wrapper detected', ((Ok 'wrapper.r5') -and (Rel (Res 'wrapper.r5').singleQuoted)), $true, $NI)
  ,@('wrapper.r5: %ProgramFiles% inside a wrapper detected (real expansion)', ((Ok 'wrapper.r5') -and (Rel (Res 'wrapper.r5').envVar)), $false, $NI)
  ,@('wrapper.r5: own-source wrapper and hs2 action stay independent', ((Ok 'wrapper.r5') -and $null -eq (Res 'wrapper.r5').ownSource -and $null -eq (Res 'wrapper.r5').hs2), $false, $NI)
  ,@('wrapper.r4 CONTROL: r4 misses both wrapper cases (IR-2 reproduced)', ((Ok 'wrapper.r4') -and $null -eq (Res 'wrapper.r4').singleQuoted -and $null -eq (Res 'wrapper.r4').envVar), $true, $NI)
)
$graded = @(); $failed = @()
foreach ($c in $checks) {
  $state = $(if ($LocalSmoke -and $c[2]) { 'SKIPPED (Windows-only)' } elseif ($c[1]) { 'PASS' } else { 'FAIL' })
  $graded += [ordered]@{ check = $c[0]; result = $state; evidence = $c[3] }; if ($state -eq 'FAIL') { $failed += $c[0] } }
$out.checks = $graded; $out.failed = $failed
$out.informational = [ordered]@{ r4ChildCompletedAfterThrow = $(if ($runs['install.r4'].result) { $runs['install.r4'].result.childCompleted } else { $null })
  r4ErrorType = $(if ($runs['install.r4'].result) { $runs['install.r4'].result.errorType } else { $null })
  statusBomR5 = $(if ($runs['pending.r5'].result) { $runs['pending.r5'].result.statusBom } else { $null }) }
$out.fixtureElapsedSec = [math]::Round($Fixture.Elapsed.TotalSeconds, 1)
$out.pass = ($failed.Count -eq 0)
$out | ConvertTo-Json -Compress -Depth 10
if ($out.pass) { exit 0 } else { exit 1 }
