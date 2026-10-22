# LOCAL logic check (pwsh 7 on Linux; NOT Windows/PS 5.1 evidence): runs native-challenge-test.ps1's section 5 text verbatim with the same
# function extraction (cutover reuse list + chact ReadJ/Live/IdsState), against synthetic files in a scratch dir.
param([string]$Dir, [string]$Scratch)
$ErrorActionPreference = 'Stop'; $asts = @{}
foreach ($k in 'chact.ps1', 'node-hold-cutover.ps1') { $tk = $null; $er = $null; $asts[$k] = [Management.Automation.Language.Parser]::ParseFile((Join-Path $Dir $k), [ref]$tk, [ref]$er) }
$fe = @($asts['chact.ps1'].FindAll({ param($x) $x -is [Management.Automation.Language.ForEachStatementAst] -and $x.Variable.VariablePath.UserPath -eq 'fn' }, $true))[0]
$names = @($fe.Condition.FindAll({ param($x) $x -is [Management.Automation.Language.StringConstantExpressionAst] }, $true) | ForEach-Object { $_.Value })
foreach ($fn in $names) { . ([scriptblock]::Create(@($asts['node-hold-cutover.ps1'].FindAll({ param($x) $x -is [Management.Automation.Language.FunctionDefinitionAst] -and $x.Name -eq $fn }, $true))[0].Extent.Text)) }
foreach ($fn in 'ReadJ', 'Live', 'IdsState') { . ([scriptblock]::Create(@($asts['chact.ps1'].FindAll({ param($x) $x -is [Management.Automation.Language.FunctionDefinitionAst] -and $x.Name -eq $fn }, $true))[0].Extent.Text)) }
$TR = ''; $Fwd = $false; $BoundSec = 120; $T0 = Get-Date; $script:QueryCleanupFailed = $false; $Stage = $Scratch; $out = [ordered]@{}
$t = [IO.File]::ReadAllText((Join-Path $Dir 'native-challenge-test.ps1')); $a = $t.IndexOf('# ---- 5 r3 IdsState'); $b = $t.IndexOf('$out.reuseOk = ')
. ([scriptblock]::Create($t.Substring($a, $b - $a)))
[ordered]@{ idsOk = $idsOk; cases = $out.ids } | ConvertTo-Json -Compress -Depth 5
if (-not $idsOk) { exit 3 }
