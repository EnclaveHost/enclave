# Root-owned Windows bootstrap test fixture. Uses an unnamed job for this process and
# its descendants. Never selects processes by path/name/command line. Unknown cleanup
# preserves evidence. Existing execution policy applies. No production VM/task changes.
param([string]$Stage, [string]$NodeExe = 'C:\Program Files\nodejs\node.exe', [string]$NodeSha = 'b3094d0b49f9ad602262a9921551737bb97637c05dd357a06ae98188d7290aa3')
$ErrorActionPreference = 'Stop'; $ProgressPreference = 'SilentlyContinue'
$sw = [Diagnostics.Stopwatch]::StartNew(); $BOUND_SEC = 900; $RESERVE_SEC = 120
$out = [ordered]@{ pass = $false; status = 'FAIL'; boundSec = $BOUND_SEC; reserveSec = $RESERVE_SEC; psVersion = $PSVersionTable.PSVersion.ToString() }
$work = $null; $swept = $false
# an error outside the steps: once children may have run and their exit is not confirmed, the result is UNKNOWN (nothing removed)
trap { $out.pass = $false; $out.error = 'fixture error: ' + $_.Exception.Message
       if ($work -and -not $swept) { $out.status = 'UNKNOWN'; $out.childExitUnknown = $true; $out.leftForRecovery = @($work, $Stage); $out | ConvertTo-Json -Compress -Depth 6; exit 5 }
       $out.status = 'FAIL'; if ($work -and (Test-Path -LiteralPath $work)) { $out.leftForRecovery = @($work) }; $out | ConvertTo-Json -Compress -Depth 6; exit 3 }
if ($PSVersionTable.PSVersion.Major -ne 5 -or [string]$PSVersionTable.PSEdition -ne 'Desktop') { $out.error = 'not Windows PowerShell 5.1 Desktop'; $out | ConvertTo-Json -Compress; exit 4 }
$out.executionPolicy = [string](Get-ExecutionPolicy)
$out.executionPolicyList = (@(Get-ExecutionPolicy -List | ForEach-Object { "$($_.Scope)=$($_.ExecutionPolicy)" }) -join ' ')
function Sha($p) { (Get-FileHash -Algorithm SHA256 -LiteralPath $p).Hash.ToLower() }
# every other staged file, exactly (the driver pins THIS script; this script pins the rest before anything runs)
$PIN = [ordered]@{
  'BootstrapCheck.cs' = '023d8d57b74daf937727472303b426192d3a49bd5793f12c819dfc4c138c53d6'
  'FixtureJob.cs' = 'b82285d61fb64dddcd2149b50a9f56d6b1ee59ba9e4e442481cf7d133125741a'
  'FixtureJobCheck.cs' = '9e2d37679695f85ff1b8eebaa40f8208b4602303100ed804989bbc476d1d0901'
  'repo\cli\host.ps1' = '9c396209801be2edeae0d8e55d76d268b495e4755a3a464925843ed21b696488'
  'repo\test\windows-native\Harness.cs' = '5ec0768735a8bba108062e804ec348ca2d2397028abe92ac839bce2387ec3547'
  'repo\test\windows-native\fixtures.json' = '4e27f00729086ebbf0a550dcffa8cf8ecf0f34d377abd400acab18bc89127721'
  'repo\test\windows-native\make-fixtures.mjs' = '94608d043f00739e34913c47c678853cd40d5bcd00b5eb9e865185a36008983e'
  'repo\test\windows-native\node-verdicts.json' = 'bbd28794165202f292dec38d9540defeb5971f7af8ebb45efc207839bdec1a9d'
  'repo\test\windows-native\run.ps1' = 'bc337ae54703a9560bc1cbace2dd503fc7bfea58bf8ddf00f3187602e8d86d1b'
  'repo\windows\installer\EnclaveSetup.cs' = '5567d0ec12f31368b3687914c48cfd807eb93806b602d6a86e23c9558095bd19'
  'repo\windows\installer\EnclaveSetup.manifest' = 'e2b9315ca02b67d5b9de90a9b246d32d5e6e134aaf041e0b12bc674a2de468cc'
  'repo\windows\installer\install-host.ps1' = '1d1580c8f9ac22f6ec96a34cea8455853b21a21cff5214187710f3483953b721'
  'repo\windows\installer\update-host.ps1' = '36f9e0d61afe58b77e566033ad1155d5c771252874f622592837c33e0a990112'
  'repo\windows\node\release-channel.mjs' = 'f690c29b606879468db94b7b78f283e7de09f94a262803e13ee4dc61b447f942'
  'repo\windows\node\update-watch.mjs' = '9104b137b884ae5d46dfa94f2ec8529d36ee2cd51c89f204eec9335cd1af46a7'
  'repo\windows\tray\TrayTheme.cs' = '6de0a61684121d635772735772908521a3eb0179a5583abf1fc1ab13469d9284'
}
$bad = @($PIN.Keys | Where-Object { -not (Test-Path -LiteralPath (Join-Path $Stage $_)) -or (Sha (Join-Path $Stage $_)) -ne $PIN[$_] })
$out.pins = ($bad.Count -eq 0); if ($bad.Count) { $out.error = 'staged bytes are not the pinned files: ' + ($bad -join ', '); $out | ConvertTo-Json -Compress; exit 3 }
# Compile only the small ownership helper, then join before any fixture workload.
try {
  Add-Type -Path (Join-Path $Stage 'FixtureJob.cs') -ErrorAction Stop
  $fixtureJob = New-Object Enclave.Testing.FixtureJob
} catch {
  $out.status = 'PRECHECK'; $out.error = 'job unavailable: ' + $_.Exception.Message
  $out | ConvertTo-Json -Compress; exit 3
}

function HardLeftMs { [int][math]::Max(0, $BOUND_SEC * 1000 - $sw.ElapsedMilliseconds) }
function StepLeftMs([int]$CapMs) { [int][math]::Max(0, [math]::Min($CapMs, ($BOUND_SEC - $RESERVE_SEC) * 1000 - $sw.ElapsedMilliseconds)) }
# L2: an argument with a quote, or ending in a backslash, cannot be quoted unambiguously here: refused, never re-split
function Quote([string[]]$A) { ($A | ForEach-Object { if ($_ -match '"' -or $_.EndsWith('\')) { throw "an argument cannot be quoted safely: $_" }; if ($_ -match '\s') { '"' + $_ + '"' } else { $_ } }) -join ' ' }
# one own child, as the retained process handle requires: monotonic budget, async output, kill its own handle, confirm exit; output is
# taken only after a confirmed exit and only within a bound (a descendant may hold the pipe open: outComplete = $false)
function Invoke-Step([string]$Exe, [string[]]$A, [int]$CapMs, [hashtable]$ChildEnv = @{}) {
  $r = [ordered]@{ code = $null; timedOut = $false; exited = $false; outComplete = $false; out = ''; err = ''; budgetMs = (StepLeftMs $CapMs); childId = $null; reason = $null; proc = $null; o = $null; e = $null }
  if ($r.budgetMs -lt 5000) { $r.reason = 'not started: no time left in the global bound'; $r.exited = $true; return [pscustomobject]$r }
  $si = New-Object Diagnostics.ProcessStartInfo $Exe; $si.Arguments = Quote $A
  $si.UseShellExecute = $false; $si.RedirectStandardOutput = $true; $si.RedirectStandardError = $true; $si.CreateNoWindow = $true
  foreach ($k in $ChildEnv.Keys) { $si.EnvironmentVariables[$k] = $ChildEnv[$k] }
  $p = New-Object Diagnostics.Process; $p.StartInfo = $si; $started = $false
  try {
    $started = $p.Start(); $r.childId = $p.Id; $r.proc = $p
    $r.o = $p.StandardOutput.ReadToEndAsync(); $r.e = $p.StandardError.ReadToEndAsync()
    $r.exited = $p.WaitForExit($r.budgetMs); $r.timedOut = -not $r.exited
  } catch { $r.reason = 'start failed: ' + $_.Exception.Message; if (-not $started) { $r.exited = $true } }
  if ($started -and -not $r.exited) { try { $p.Kill() } catch { }; $r.exited = $p.WaitForExit([int][math]::Min(10000, (HardLeftMs))) }
  if ($started -and $r.exited) {
    $r.code = $p.ExitCode
    if ($r.o -and $r.o.Wait([int][math]::Min(10000, (HardLeftMs))) -and $r.e.Wait([int][math]::Min(2000, (HardLeftMs)))) { $r.outComplete = $true; $r.out = [string]$r.o.Result; $r.err = [string]$r.e.Result }
  } elseif ($started) { $r.reason = 'child exit unconfirmed after kill' }
  [pscustomobject]$r
}
# Membership is kernel tracked. The same open handle is checked and terminated;
# repeated snapshots cover descendants created while cleanup is in progress.
function Stop-Own { $fixtureJob.StopChildren((HardLeftMs)) }
# the harness's lines (run.ps1 prints "PASS|FAIL  <area> <name>" and "SKIP  ..."; its first line is "work folder: ...")
function Read-Harness($h) {
  $lines = @(([string]$h.out) -split "`r?`n" | Where-Object { $_ }); $text = ([string]$h.out + ' ' + [string]$h.err).Trim()
  $refused = ($h.code -ne 0 -and @($lines | Where-Object { $_ -like 'work folder: *' }).Count -eq 0 -and $text -match '(?i)execution polic|not digitally signed|running scripts is disabled')
  [ordered]@{ code = $h.code; timedOut = $h.timedOut; budgetMs = $h.budgetMs; outComplete = $h.outComplete
              pass = @($lines | Where-Object { $_ -like 'PASS*' }).Count; fail = @($lines | Where-Object { $_ -like 'FAIL*' }).Count
              skip = @($lines | Where-Object { $_ -like 'SKIP*' }).Count
              nodeCheckPassed = (@($lines | Where-Object { $_ -match '^PASS\s+node\s+release-channel\.mjs re-judged every fixture here' }).Count -eq 1)
              failLines = @($lines | Where-Object { $_ -like 'FAIL*' } | Select-Object -First 20); skipLines = @($lines | Where-Object { $_ -like 'SKIP*' })
              policyRefused = $refused; refusal = $(if ($refused) { $text.Substring(0, [math]::Min(600, $text.Length)) } else { $null }) }
}
# full success needs EVERY check, the Node verifier run and passed, and no skipped harness check; otherwise the evidence is
# PARTIAL (reported with its reasons, never a pass). A refusal by the execution policy is REFUSED.
function Verdict($o, $checks, [bool]$inBound) {
  $partial = @()
  if (-not $o.nodeUsed) { $partial += "the Node verifier did not run: $NodeExe is absent or not $($NodeSha.Substring(0, 8))" }
  elseif (-not ($o.harness -and $o.harness.nodeCheckPassed)) { $partial += 'the harness printed no PASS line for the Node re-judge' }
  if ($o.harness -and $o.harness.skip -gt 0) { $partial += "$($o.harness.skip) harness check(s) skipped: " + ($o.harness.skipLines -join ' | ') }
  $allOk = ($checks.Count -eq 5) -and -not $o.error -and (@($checks.Values | Where-Object { -not $_ }).Count -eq 0) -and $o.workRemoved -and $inBound
  [pscustomobject]@{ status = $(if ($o.harnessPolicyRefused) { 'REFUSED' } elseif (-not $allOk) { 'FAIL' } elseif ($partial.Count) { 'PARTIAL' } else { 'PASS' }); partial = $partial }
}

$R = Join-Path $Stage 'repo'; $csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path -LiteralPath $csc)) { $csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe' }
$out.csc = [ordered]@{ path = $csc; sha256 = $(if (Test-Path -LiteralPath $csc) { Sha $csc } else { 'absent' }); version = $(if (Test-Path -LiteralPath $csc) { (Get-Item -LiteralPath $csc).VersionInfo.FileVersion } else { $null }) }
$workLeaf = 'enclave-bootstrap-' + [guid]::NewGuid().ToString('N').Substring(0, 12); $stageLeaf = Split-Path -Leaf $Stage
if ($stageLeaf -notmatch '^distribution-bootstrap-job-native-[0-9a-f]{12}$') { throw 'the stage is not a distribution-bootstrap-job-native stage' }
$work = Join-Path $env:TEMP $workLeaf; $htemp = Join-Path $work 'htemp'; [void][IO.Directory]::CreateDirectory($htemp)
$checks = [ordered]@{}; $unconfirmed = New-Object Collections.ArrayList; $notRun = New-Object Collections.ArrayList; $h = $null
function Ran($x, [string]$name) {   # an unconfirmed exit stops everything; a step the bound left no time for is recorded
  if (-not $x.exited) { [void]$unconfirmed.Add($x); throw "$name : child exit unconfirmed; nothing else runs" }
  if ($x.reason) { [void]$notRun.Add("$name ($($x.reason))") } }
try {
  # Exercise native ownership, orphan cleanup and same-path decoy survival first.
  $jobExe = Join-Path $work 'FixtureJobCheck.exe'
  $jbuild = Invoke-Step $csc @('/nologo', '/target:exe', ('/out:' + $jobExe),
    (Join-Path $Stage 'FixtureJob.cs'), (Join-Path $Stage 'FixtureJobCheck.cs')) 60000
  Ran $jbuild 'job test compile'
  $checks.processOwnership = $false
  $out.jobBuild = [ordered]@{ code = $jbuild.code; output = ($jbuild.out + $jbuild.err).Trim() }
  if ($jbuild.code -ne 0 -or $jbuild.timedOut) { throw 'job test compile failed' }
  $jtest = Invoke-Step $jobExe @($work) 60000
  Ran $jtest 'job ownership tests'
  $checks.processOwnership = ($jtest.code -eq 0 -and -not $jtest.timedOut -and $jtest.outComplete -and $jtest.out -match 'ALL PASS')
  $out.jobTests = [ordered]@{ code = $jtest.code; output = ($jtest.out + $jtest.err).Trim() }
  if (-not $checks.processOwnership) { throw 'native process ownership checks failed' }

  # ---- 1 the shipping scripts parse with Windows PowerShell 5.1 (in process: no child)
  $parse = [ordered]@{}
  foreach ($s in 'cli\host.ps1', 'windows\installer\install-host.ps1', 'windows\installer\update-host.ps1', 'test\windows-native\run.ps1') {
    $t = $null; $er = $null; [void][Management.Automation.Language.Parser]::ParseFile((Join-Path $R $s), [ref]$t, [ref]$er); $parse[$s] = $er.Count }
  $out.parseErrors = $parse; $checks.parse = (@($parse.Values | Where-Object { $_ -ne 0 }).Count -eq 0)

  # ---- 2 EnclaveSetup.exe exactly as build-setup.cmd builds it (its flags and references), except /win32icon (cosmetic only:
  #      the icon comes from a tray build that downloads WebView2; this compile adds no dependency). Built, hashed, NEVER run.
  $refs = @('/r:System.dll', '/r:System.Drawing.dll', '/r:System.Windows.Forms.dll', '/r:System.Web.Extensions.dll', '/r:System.IO.Compression.dll', '/r:System.IO.Compression.FileSystem.dll')
  $setupExe = Join-Path $work 'EnclaveSetup.exe'
  $b = Invoke-Step $csc (@('/nologo', '/target:winexe', '/platform:anycpu', '/optimize+', '/warn:4', '/main:Enclave.Setup.SetupProgram', ('/win32manifest:' + (Join-Path $R 'windows\installer\EnclaveSetup.manifest')), ('/out:' + $setupExe)) + $refs +
                         @((Join-Path $R 'windows\installer\EnclaveSetup.cs'), (Join-Path $R 'windows\tray\TrayTheme.cs'))) 300000
  Ran $b 'setup compile'
  $out.setupBuild = [ordered]@{ code = $b.code; timedOut = $b.timedOut; budgetMs = $b.budgetMs; output = ($b.out + $b.err).Trim(); exeSha256 = $(if (Test-Path -LiteralPath $setupExe) { Sha $setupExe } else { $null }); exeBytes = $(if (Test-Path -LiteralPath $setupExe) { (Get-Item -LiteralPath $setupExe).Length } else { $null }) }
  $checks.setupCompiles = ($b.code -eq 0 -and -not $b.timedOut -and (Test-Path -LiteralPath $setupExe))

  # ---- 3 BootstrapCheck: the real PinPolicy / ReadBounded / SetupOptions / QuoteArgs from the same EnclaveSetup.cs, in %TEMP% only
  $chkExe = Join-Path $work 'BootstrapCheck.exe'
  $c = Invoke-Step $csc (@('/nologo', '/target:exe', '/platform:anycpu', '/main:Enclave.Setup.BootstrapCheck', ('/out:' + $chkExe)) + $refs +
                         @((Join-Path $R 'windows\installer\EnclaveSetup.cs'), (Join-Path $R 'windows\tray\TrayTheme.cs'), (Join-Path $Stage 'BootstrapCheck.cs'))) 300000
  Ran $c 'check compile'
  $out.checkBuild = [ordered]@{ code = $c.code; timedOut = $c.timedOut; budgetMs = $c.budgetMs; output = ($c.out + $c.err).Trim() }
  $checks.bootstrap = $false
  if ($c.code -eq 0 -and -not $c.timedOut) {
    $bw = Join-Path $work 'bootstrap'; [void][IO.Directory]::CreateDirectory($bw)
    $r = Invoke-Step $chkExe @((Join-Path $R 'test\windows-native\fixtures.json'), $bw) 120000
    Ran $r 'BootstrapCheck'
    $out.bootstrap = [ordered]@{ code = $r.code; timedOut = $r.timedOut; budgetMs = $r.budgetMs; lines = @($r.out -split "`r?`n" | Where-Object { $_ }) }
    $checks.bootstrap = ($r.code -eq 0 -and -not $r.timedOut -and $r.outComplete -and ($r.out -match 'ALL PASS'))
  }

  # ---- 4 the repo's own native harness over the staged tree, under the operator's execution policy. Its TEMP is this run's
  #      htemp folder, so its work folder, Harness.exe and the loopback server's port file all carry this run's unique name.
  $ps = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  $hargs = @('-NoProfile', '-NonInteractive', '-File', (Join-Path $R 'test\windows-native\run.ps1'))
  $out.nodeUsed = ((Test-Path -LiteralPath $NodeExe) -and (Sha $NodeExe) -eq $NodeSha); if ($out.nodeUsed) { $hargs += @('-Node', $NodeExe) }
  $h = Invoke-Step $ps $hargs 600000 @{ TEMP = $htemp; TMP = $htemp }
  Ran $h 'harness'
} catch { $out.error = $_.Exception.Message }

# ---- after the steps, always: a timed-out harness's loopback server gets its stop file; then every own process is stopped
#      and confirmed gone through job membership; a step's unconfirmed handle must also have exited
$out.harnessStopFiles = 0
if ($h -and ($h.timedOut -or -not $h.outComplete)) {
  foreach ($d in @(Get-ChildItem -LiteralPath $htemp -Directory -Filter 'enclave-native-*' -ErrorAction SilentlyContinue)) {
    $pf = Join-Path $d.FullName 'port.txt'; if (Test-Path -LiteralPath $pf) { [IO.File]::WriteAllText("$pf.stop", ''); $out.harnessStopFiles++ } }
}
$sweep = Stop-Own
$out.notRun = @($notRun)
$out.processSweep = [ordered]@{ ok = $sweep.ok; found = $sweep.found; killed = $sweep.killed; why = $sweep.why }
$stillUnknown = @($unconfirmed | Where-Object { -not $_.proc.WaitForExit(0) })
$out.childExitUnknown = (-not $sweep.ok) -or ($stillUnknown.Count -gt 0); $swept = -not $out.childExitUnknown
if ($out.childExitUnknown) {
  $fixtureJob.Dispose()
  $out.status = 'UNKNOWN'; $out.pass = $false; $out.leftForRecovery = @($work, $Stage); $out.seconds = [math]::Round($sw.Elapsed.TotalSeconds, 1)
  $out.checks = $checks; $out | ConvertTo-Json -Compress -Depth 6; exit 5
}

$fixtureJob.Dispose()
# ---- the harness's verdict (its output, if it was held open by a descendant, is complete now that none remains)
if ($h -and $h.proc) {
  if (-not $h.outComplete -and $h.o -and $h.o.Wait([int][math]::Min(2000, (HardLeftMs))) -and $h.e.Wait([int][math]::Min(1000, (HardLeftMs)))) { $h.outComplete = $true; $h.out = [string]$h.o.Result; $h.err = [string]$h.e.Result }
  $out.harness = Read-Harness $h
  $out.harnessPolicyRefused = $out.harness.policyRefused
  $checks.harness = ($h.code -eq 0 -and -not $h.timedOut -and $h.outComplete -and $out.harness.fail -eq 0 -and $out.harness.pass -gt 0)
  $hw = @(Get-ChildItem -LiteralPath $htemp -Directory -Filter 'enclave-native-*' -ErrorAction SilentlyContinue)
  if ($hw.Count -eq 1 -and (Test-Path -LiteralPath (Join-Path $hw[0].FullName 'results.json'))) { $out.harnessResultsSha256 = Sha (Join-Path $hw[0].FullName 'results.json') }
}
# ---- removal only now: every own child has exited (confirmed)
if (Test-Path -LiteralPath $work) { Remove-Item -LiteralPath $work -Recurse -Force }
$out.workRemoved = -not (Test-Path -LiteralPath $work)
$out.checks = $checks; $out.seconds = [math]::Round($sw.Elapsed.TotalSeconds, 1)
$v = Verdict $out $checks ($sw.Elapsed.TotalSeconds -le $BOUND_SEC)
$out.status = $v.status; $out.partialReasons = $v.partial; $out.pass = ($out.status -eq 'PASS')
$out | ConvertTo-Json -Compress -Depth 6
exit $(switch ($out.status) { 'PASS' { 0 } 'PARTIAL' { 6 } 'REFUSED' { 7 } default { 1 } })
