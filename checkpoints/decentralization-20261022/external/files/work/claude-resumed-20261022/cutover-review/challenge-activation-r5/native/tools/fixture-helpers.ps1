# r4 LOCAL fault tests (pwsh 7 on Linux; NOT Windows evidence) of the native fixture's own-process helpers, AST-extracted from the EXACT
# native-challenge-test.ps1 bytes (never re-typed), driving REAL own node children. Prints one JSON object per case.
param([string]$Fixture, [string]$Cutover, [string]$Node, [string]$Scratch)
$ErrorActionPreference = 'Stop'
$tk = $null; $er = $null; $ast = [Management.Automation.Language.Parser]::ParseFile($Fixture, [ref]$tk, [ref]$er); if ($er.Count) { throw 'fixture parse errors' }
$cut = [Management.Automation.Language.Parser]::ParseFile($Cutover, [ref]$tk, [ref]$er)
function Extract($tree, $name) { $f = @($tree.FindAll({ param($x) $x -is [Management.Automation.Language.FunctionDefinitionAst] -and $x.Name -eq $name }.GetNewClosure(), $true))
  if ($f.Count -ne 1) { throw "expected exactly one $name" }; . ([scriptblock]::Create($f[0].Extent.Text)) }
$HELPERS = 'RegLine', 'StartUtc', 'ArgLine', 'Spawn', 'KillOwned', 'WaitOwned', 'RunOwned', 'CleanupOwned', 'Need'
foreach ($n in $HELPERS) { . Extract $ast $n }
foreach ($n in 'Left', 'Lim') { . Extract $cut $n }
$Fwd = $false
function Fresh($name) { $script:QueryCleanupFailed = $false; $script:Owned = [Collections.ArrayList]::new(); $script:REG = Join-Path $Scratch "$name.jsonl"; $script:BoundSec = 130; $script:T0 = Get-Date }
function Lines { if (Test-Path -LiteralPath $REG) { @([IO.File]::ReadAllLines($REG) | ForEach-Object { $_ | ConvertFrom-Json }) } else { @() } }
function Emit($o) { $o | ConvertTo-Json -Compress -Depth 6 }

# 1 a normal bounded child: exit code and output, registered with PID + start
Fresh 'ok'; $t = [Diagnostics.Stopwatch]::StartNew()
$r = RunOwned 'edit' $Node @('-e', 'console.log(JSON.stringify({a:1}))') 20000
Emit ([ordered]@{ case = 'ok'; ok = $r.ok; exit = $r.exit; exited = $r.exited; stdoutHasJson = ([string]$r.stdout -like '*{"a":1}*'); reg = @(Lines).Count; regHasStart = (@(Lines)[0].start -ne 'unknown'); sec = $t.Elapsed.TotalSeconds })
# 2 timeout: killed and its exit confirmed within the bound; output never read
Fresh 'timeout'; $t = [Diagnostics.Stopwatch]::StartNew()
$r = RunOwned 'edit' $Node @('-e', 'setTimeout(()=>{},60000)') 4000
Emit ([ordered]@{ case = 'timeout'; ok = $r.ok; timedOut = $r.timedOut; exited = $r.exited; stdoutNull = ($null -eq $r.stdout); reason = $r.reason; sec = $t.Elapsed.TotalSeconds; procGone = $script:Owned[0].proc.HasExited })
# 3 the kill FAILS (injected): still returns within the bound, exit NOT claimed, no .Result read; the final cleanup then confirms it
Fresh 'killfails'; $t = [Diagnostics.Stopwatch]::StartNew()
function KillOwned($p) { }                                       # injected fault: the child survives the stop
$r = RunOwned 'edit' $Node @('-e', 'setTimeout(()=>{},60000)') 4000
$first = [ordered]@{ ok = $r.ok; timedOut = $r.timedOut; exited = $r.exited; stdoutNull = ($null -eq $r.stdout); reason = $r.reason; sec = $t.Elapsed.TotalSeconds; stillRunning = -not $script:Owned[0].proc.HasExited }
$c1 = CleanupOwned 3000                                          # cleanup with the fault still present: NOT allExited
. Extract $ast 'KillOwned'                                       # the real KillOwned again
$c2 = CleanupOwned 10000
Emit ([ordered]@{ case = 'killfails'; first = $first; cleanupWhileFaulty = $c1.allExited; cleanupAfter = $c2.allExited; procGone = $script:Owned[0].proc.HasExited; regFinal = @(Lines | Where-Object { $_.cleanup }).Count })
# 4 a spawn failure is reported and leaves nothing registered
Fresh 'spawnfail'
$r = RunOwned 'edit' (Join-Path $Scratch 'no-such-node') @('-e', '1') 10000
Emit ([ordered]@{ case = 'spawnfail'; ok = $r.ok; reason = $r.reason; owned = $script:Owned.Count; reg = @(Lines).Count })
# 5 section 2 shape: the replica starts, the DECOY spawn fails; the registered replica is still killed and confirmed by the final cleanup
Fresh 'decoyfail'; $thrown = $false
try { $rep = Spawn 'replica' $Node @('-e', 'setTimeout(()=>{},90000)', 'dns.mjs') $false; $decoy = Spawn 'decoy' (Join-Path $Scratch 'no-such-node') @('-e', '1') $false } catch { $thrown = $true }
$c = CleanupOwned 10000
$fin = @(Lines | Where-Object { $_.cleanup })[-1]
Emit ([ordered]@{ case = 'decoyfail'; thrown = $thrown; owned = $script:Owned.Count; allExited = $c.allExited; replicaGone = $rep.HasExited; finalAllExited = $fin.allExited; finalQueryCleanupFailed = $fin.queryCleanupFailed; regRoles = @(Lines | Where-Object { $_.role } | ForEach-Object { $_.role }) })
# 6 Need: a section that no longer fits refuses (no work started); 7 ArgLine refuses what it cannot quote
Fresh 'need'; $script:BoundSec = 5; $script:T0 = (Get-Date).AddSeconds(-2)
$needThrew = $false; try { Need 10 'orphans' } catch { $needThrew = $_.Exception.Message -like 'deadline: orphans needs 10 s*' }
$q = @(); foreach ($a in 'a"b', 'C:\dir\') { try { ArgLine @($a) | Out-Null; $q += $false } catch { $q += $true } }
Emit ([ordered]@{ case = 'need'; needThrew = $needThrew; argRefused = $q; quoted = (ArgLine @('C:\Program Files\x.mjs', '-e')) })
