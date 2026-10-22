# local syntax + reuse-list check (pwsh 7; NOT Windows evidence): every script parses; the activation script's reuse list names functions
# that exist exactly once in the pinned cutover df2e58f2
param([string]$Dir)
$ErrorActionPreference = 'Stop'; $r = [ordered]@{}; $asts = @{}
foreach ($k in 'chact.ps1', 'node-hold-cutover.ps1', 'native-challenge-test.ps1') { $tk = $null; $er = $null; $asts[$k] = [Management.Automation.Language.Parser]::ParseFile((Join-Path $Dir $k), [ref]$tk, [ref]$er); $r[$k] = $er.Count }
$fe = @($asts['chact.ps1'].FindAll({ param($x) $x -is [Management.Automation.Language.ForEachStatementAst] -and $x.Variable.VariablePath.UserPath -eq 'fn' }, $true))[0]
$names = @($fe.Condition.FindAll({ param($x) $x -is [Management.Automation.Language.StringConstantExpressionAst] }, $true) | ForEach-Object { $_.Value })
$once = @($names | Where-Object { $n = $_; @($asts['node-hold-cutover.ps1'].FindAll({ param($x) $x -is [Management.Automation.Language.FunctionDefinitionAst] -and $x.Name -eq $n }, $true)).Count -eq 1 })
$own = @('DeclState','Owner','ReplicaChildren','StopOrphans','CoreUp','Recovery','Revert' | Where-Object { $n = $_; @($asts['chact.ps1'].FindAll({ param($x) $x -is [Management.Automation.Language.FunctionDefinitionAst] -and $x.Name -eq $n }, $true)).Count -eq 1 })
[ordered]@{ parseErrors = $r; reuseNames = $names.Count; foundOnce = $once.Count; ownFunctions = $own.Count } | ConvertTo-Json -Compress
if (@($r.Values | Where-Object { $_ }).Count -or $once.Count -ne $names.Count -or $own.Count -ne 7) { exit 3 }
