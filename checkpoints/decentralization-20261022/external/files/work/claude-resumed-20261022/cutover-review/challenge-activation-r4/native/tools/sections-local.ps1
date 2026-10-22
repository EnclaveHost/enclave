# r4 POSITIVE local run (pwsh 7 on Linux; NOT Windows/PS 5.1 evidence): native-challenge-test.ps1's sections 3 (edit helper as a bounded
# own child, real node + the pinned edit-privacy-config.mjs), 4 (DeclState) and 5 (IdsState) executed VERBATIM from the exact fixture
# bytes, with every function AST-extracted exactly as the fixture does (cutover reuse list, chact functions, fixture helpers), the
# fixture's own $PINS statement, and a Stage whose path contains a space (argv quoting of the bounded child exercised).
# Sections 1-2 need Windows listener/process queries and are not run here. Ends with the fixture's own CleanupOwned.
param([string]$Dir, [string]$Stage, [string]$NodeExe)
$ErrorActionPreference = 'Stop'; $sw = [Diagnostics.Stopwatch]::StartNew(); $asts = @{}
foreach ($k in 'chact.ps1', 'node-hold-cutover.ps1', 'native-challenge-test.ps1') { $tk = $null; $er = $null; $asts[$k] = [Management.Automation.Language.Parser]::ParseFile((Join-Path $Dir $k), [ref]$tk, [ref]$er); if ($er.Count) { throw "$k parse" } }
function Def($tree, $name) { @($tree.FindAll({ param($x) $x -is [Management.Automation.Language.FunctionDefinitionAst] -and $x.Name -eq $name }.GetNewClosure(), $true))[0].Extent.Text }
$fe = @($asts['chact.ps1'].FindAll({ param($x) $x -is [Management.Automation.Language.ForEachStatementAst] -and $x.Variable.VariablePath.UserPath -eq 'fn' }, $true))[0]
$names = @($fe.Condition.FindAll({ param($x) $x -is [Management.Automation.Language.StringConstantExpressionAst] }, $true) | ForEach-Object { $_.Value })
foreach ($fn in $names) { . ([scriptblock]::Create((Def $asts['node-hold-cutover.ps1'] $fn))) }
foreach ($fn in 'DeclState', 'Owner', 'ReplicaChildren', 'Alive', 'StopOrphans', 'ReadJ', 'Live', 'IdsState') { . ([scriptblock]::Create((Def $asts['chact.ps1'] $fn))) }
foreach ($fn in 'RegLine', 'StartUtc', 'ArgLine', 'Spawn', 'KillOwned', 'WaitOwned', 'RunOwned', 'CleanupOwned', 'Need') { . ([scriptblock]::Create((Def $asts['native-challenge-test.ps1'] $fn))) }
$pinsAst = @($asts['native-challenge-test.ps1'].FindAll({ param($x) $x -is [Management.Automation.Language.AssignmentStatementAst] -and $x.Left.Extent.Text -eq '$PINS' }, $true))[0]
. ([scriptblock]::Create($pinsAst.Extent.Text))
$BOUND = 150; $BoundSec = 130; $T0 = Get-Date; $TR = ''; $Fwd = $false; $script:QueryCleanupFailed = $false; $out = [ordered]@{}
$REG = Join-Path $Stage 'owned.jsonl'; $script:Owned = [Collections.ArrayList]::new()
$t = [IO.File]::ReadAllText((Join-Path $Dir 'native-challenge-test.ps1'))
$a = $t.IndexOf('  # ---- 3 '); $b = $t.IndexOf('  $out.reuseOk = '); if ($a -lt 0 -or $b -lt $a) { throw 'section markers not found' }
try { . ([scriptblock]::Create($t.Substring($a, $b - $a))) } finally { $cl = CleanupOwned 10000 }
[ordered]@{ renderOk = [bool]$renderOk; render = $out.render; declOk = [bool]$declOk; idsOk = [bool]$idsOk; ids = $out.ids; allExited = $cl.allExited
  registered = @([IO.File]::ReadAllLines($REG) | ForEach-Object { ($_ | ConvertFrom-Json) } | Where-Object { $_.role } | ForEach-Object { $_.role })
  spaceInStage = $Stage.Contains(' '); sec = [math]::Round($sw.Elapsed.TotalSeconds, 1) } | ConvertTo-Json -Compress -Depth 6
if (-not ($renderOk -and $declOk -and $idsOk -and $cl.allExited)) { exit 3 }
