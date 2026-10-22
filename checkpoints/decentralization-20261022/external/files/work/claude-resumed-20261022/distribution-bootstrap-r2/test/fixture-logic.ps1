# LOCAL test of native-bootstrap.ps1's changed logic (Linux pwsh 7; NOT Windows evidence). The EXACT function texts are taken
# from the fixture's AST: HardLeftMs, StepLeftMs, Quote, Invoke-Step, Find-Own, Stop-Own, Read-Harness, Verdict. The only
# stand-in is Invoke-BoundedQuery (Win32_Process/CIM does not exist here): it lists this test's processes whose command line
# names the unique work leaf, as the real query does, and can be told to fail or to report a shifted start time.
#   pwsh -NoProfile -File fixture-logic.ps1 <native-bootstrap.ps1>
param([string]$Fixture)
$ErrorActionPreference = 'Stop'
$t = $null; $e = $null; $ast = [Management.Automation.Language.Parser]::ParseFile($Fixture, [ref]$t, [ref]$e)
if ($e.Count) { throw "fixture parse errors: $($e.Count)" }
$want = 'HardLeftMs', 'StepLeftMs', 'Quote', 'Invoke-Step', 'Find-Own', 'Stop-Own', 'Read-Harness', 'Verdict'
foreach ($f in $ast.FindAll({ param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $want -contains $n.Name }, $false)) { . ([scriptblock]::Create($f.Extent.Text)) }
foreach ($n in $want) { if (-not (Get-Command $n -CommandType Function -ErrorAction SilentlyContinue)) { throw "fixture function missing: $n" } }
$QUERY = 'unused by the stand-in'; $NodeExe = 'C:\Program Files\nodejs\node.exe'; $NodeSha = 'b3094d0b49f9ad602262a9921551737bb97637c05dd357a06ae98188d7290aa3'
$workLeaf = 'enclave-bootstrap-' + [guid]::NewGuid().ToString('N').Substring(0, 12); $stageLeaf = 'distribution-bootstrap-r2-native-000000000000'
$work = Join-Path ([IO.Path]::GetTempPath()) $workLeaf; [void][IO.Directory]::CreateDirectory($work)
$script:queryFails = $false; $script:skew = [long]0
function Invoke-BoundedQuery([scriptblock]$Query, [int]$BudgetMs) {
  if ($script:queryFails) { return [pscustomobject]@{ ok = $false; reason = 'stand-in failure'; value = $null } }
  $v = @(Get-Process | Where-Object { try { ([string]$_.CommandLine).Contains($workLeaf) } catch { $false } } |
         ForEach-Object { [pscustomobject]@{ id = $_.Id; path = [string]$_.Path; cmd = [string]$_.CommandLine; created = $_.StartTime.ToUniversalTime().Ticks + $script:skew } })
  [pscustomobject]@{ ok = $true; reason = $null; value = $(if ($v.Count -eq 1) { $v[0] } else { $v }) }   # ConvertFrom-Json unwraps one item
}
$results = @()
function Check([string]$n, [bool]$ok, [string]$d = '') { $script:results += (($(if ($ok) { 'PASS ' } else { 'FAIL ' })) + $n + $(if (-not $ok -and $d) { "  ($d)" } else { '' })) }
$hold = Join-Path $work 'hold.sh'; [IO.File]::WriteAllText($hold, "while :; do sleep 1; done`n")   # the shell itself stays (its command line names the work leaf)

# S1 a step past its budget is killed by its own handle and its exit confirmed, within the budget plus the kill wait
$BOUND_SEC = 900; $RESERVE_SEC = 120; $sw = [Diagnostics.Stopwatch]::StartNew()
$a = [Diagnostics.Stopwatch]::StartNew(); $r = Invoke-Step '/bin/sh' @($hold) 6000
Check 'S1 a step past its cap: killed, exit confirmed, no output wait past the bound' ($r.timedOut -and $r.exited -and $r.proc.HasExited -and $a.ElapsedMilliseconds -lt 9000 -and $r.budgetMs -eq 6000) "$($a.ElapsedMilliseconds) ms budget=$($r.budgetMs) timedOut=$($r.timedOut) exited=$($r.exited)"

# S2 the global bound (minus the cleanup reserve) caps every step; with < 5 s left a step is not started at all
$BOUND_SEC = 130; $RESERVE_SEC = 120; $sw = [Diagnostics.Stopwatch]::StartNew()
$a = [Diagnostics.Stopwatch]::StartNew(); $r = Invoke-Step '/bin/sh' @($hold) 600000
Check 'S2 a 600 s step cap is cut to the global bound minus the reserve (10 s)' ($r.timedOut -and $r.exited -and $r.budgetMs -le 10000 -and $r.budgetMs -gt 9000 -and $a.ElapsedMilliseconds -lt 13000) "$($r.budgetMs) ms budget, $($a.ElapsedMilliseconds) ms"
$BOUND_SEC = 124; $sw = [Diagnostics.Stopwatch]::StartNew(); $r = Invoke-Step '/bin/sh' @($hold) 600000
Check 'S2b with < 5 s left before the reserve, no child is started' ($null -eq $r.childId -and $r.exited -and $r.reason -like 'not started*') "$($r.reason)"

# S3 a child that exits while a descendant (named by the work folder) holds its stdout: no blocking read; Stop-Own kills the
#    descendant by pid + start time and confirms by a second query; the output is complete afterwards
$BOUND_SEC = 900; $RESERVE_SEC = 120; $sw = [Diagnostics.Stopwatch]::StartNew()
$a = [Diagnostics.Stopwatch]::StartNew(); $r = Invoke-Step '/bin/sh' @('-c', "/bin/sh '$hold' & echo started") 20000
Check 'S3 a parent whose pipe a descendant holds: exit confirmed, outComplete false, bounded' ($r.exited -and -not $r.timedOut -and -not $r.outComplete -and $a.ElapsedMilliseconds -lt 13000) "$($a.ElapsedMilliseconds) ms"
$s = Stop-Own
$late = $r.o.Wait(3000)
Check 'S3b Stop-Own kills the held-pipe descendant, confirms none remain; the output then completes' ($s.ok -and $s.found -ge 1 -and @($s.killed).Count -ge 1 -and $late -and $r.o.Result -match 'started') "$($s | ConvertTo-Json -Compress -Depth 3)"

# S6 the harness's TEMP/TMP are this run's own folder (its work folder, Harness.exe and port file then carry the unique leaf)
$r = Invoke-Step '/bin/sh' @('-c', 'echo "$TEMP|$TMP"') 10000 @{ TEMP = $work; TMP = $work }
Check 'S6 the child environment carries the fixture-owned TEMP and TMP' ($r.outComplete -and $r.out.Trim() -eq "$work|$work") "$($r.out)"
# S4 a failed process query is never "nothing left": Stop-Own is not ok (the fixture then reports UNKNOWN and removes nothing)
$p = Start-Process -FilePath '/bin/sh' -ArgumentList @($hold) -PassThru
$script:queryFails = $true; $s = Stop-Own; $script:queryFails = $false
Check 'S4 a failed process query: not ok, nothing killed' (-not $s.ok -and @($s.killed).Count -eq 0 -and -not $p.HasExited) "$($s.why)"
# S5 a pid whose start time differs (pid reused) is never killed; the confirming query still sees it: not ok
$script:skew = [long]600000000; $s = Stop-Own; $script:skew = [long]0
Check 'S5 a start-time mismatch is not killed and leaves Stop-Own not ok' (-not $s.ok -and @($s.killed).Count -eq 0 -and -not $p.HasExited) "$($s.why)"
$s = Stop-Own
Check 'S5b with the start time matching, it is killed and confirmed gone' ($s.ok -and $p.WaitForExit(5000)) "$($s.why)"

# V verdicts from harness outputs in run.ps1's own line format
$okLines = "work folder: C:\x\enclave-native-1`nPASS  parse       cli\host.ps1`nPASS  node        release-channel.mjs re-judged every fixture here`nPASS  SecureWorkDir an absent folder is made"
function HOut($o, $code = 0, $err = '') { [pscustomobject]@{ code = $code; timedOut = $false; budgetMs = 1; outComplete = $true; out = $o; err = $err } }
function Judge($hout, [bool]$node = $true, $checks = [ordered]@{ parse = $true; setupCompiles = $true; bootstrap = $true; harness = $true }) {
  $o = [ordered]@{ nodeUsed = $node; workRemoved = $true; harness = (Read-Harness $hout) }; $o.harnessPolicyRefused = $o.harness.policyRefused
  Verdict $o $checks $true }
$v = Judge (HOut $okLines); Check 'V1 every check, the Node re-judge and no SKIP: PASS' ($v.status -eq 'PASS' -and $v.partial.Count -eq 0) "$($v.status)"
$v = Judge (HOut ($okLines -replace 'PASS  node.*', '')) $false; Check 'V2 node.exe absent / not pinned: PARTIAL, with the reason' ($v.status -eq 'PARTIAL' -and "$($v.partial)" -match 'Node verifier did not run') "$($v.status) $($v.partial)"
$v = Judge (HOut ($okLines -replace 'PASS  node.*', '')) $true; Check 'V3 node pinned but no Node PASS line: PARTIAL' ($v.status -eq 'PARTIAL' -and "$($v.partial)" -match 'no PASS line') "$($v.status)"
$v = Judge (HOut ($okLines -replace 'PASS  SecureWorkDir.*', 'SKIP  SecureWorkDir: run as Administrator to test it')); Check 'V4 a skipped harness check: PARTIAL, naming it' ($v.status -eq 'PARTIAL' -and "$($v.partial)" -match '1 harness check\(s\) skipped: SKIP  SecureWorkDir') "$($v.status) $($v.partial)"
$v = Judge (HOut "$okLines`nFAIL  csharp      x" 1) $true ([ordered]@{ parse = $true; setupCompiles = $true; bootstrap = $true; harness = $false }); Check 'V5 a failed check: FAIL (never PARTIAL)' ($v.status -eq 'FAIL') "$($v.status)"
$v = Judge (HOut '' 1 'File C:\s\run.ps1 cannot be loaded because running scripts is disabled on this system. For more information, see about_Execution_Policies') $true ([ordered]@{ parse = $true; setupCompiles = $true; bootstrap = $true; harness = $false })
Check 'V6 the execution policy refused the harness: REFUSED' ($v.status -eq 'REFUSED') "$($v.status)"
$v = Judge (HOut '' 1 'File C:\s\run.ps1 cannot be loaded. The file C:\s\run.ps1 is not digitally signed.') $true ([ordered]@{ parse = $true; setupCompiles = $true; bootstrap = $true; harness = $false })
Check 'V6b AllSigned refusal: REFUSED' ($v.status -eq 'REFUSED') "$($v.status)"
$v = Judge (HOut $okLines) $true ([ordered]@{ parse = $true; setupCompiles = $true; bootstrap = $true }); Check 'V7 a check that never ran (3 of 4): FAIL' ($v.status -eq 'FAIL') "$($v.status)"
# T static: no execution-policy override anywhere in the fixture (it only reads the effective policy)
$src = [IO.File]::ReadAllText($Fixture)
Check 'T1 the fixture passes no -ExecutionPolicy and has no Bypass' (-not ($src -match "'-ExecutionPolicy'|Bypass|Unrestricted|Set-ExecutionPolicy")) ''
Remove-Item -LiteralPath $work -Recurse -Force
$results
"$(@($results | Where-Object { $_ -like 'PASS*' }).Count) passed, $(@($results | Where-Object { $_ -like 'FAIL*' }).Count) failed"
if (@($results | Where-Object { $_ -like 'FAIL*' }).Count) { exit 1 }
