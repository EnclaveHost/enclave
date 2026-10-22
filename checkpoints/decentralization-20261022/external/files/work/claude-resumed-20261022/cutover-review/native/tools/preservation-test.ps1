# Focused check of the fixture's preservation logic (AST-extracted from the exact native-test.ps1 / cutover.ps1 bytes) on
# SYNTHETIC snapshots: unavailable or empty observations must be UNOBSERVED and must never count as preserved.
param([string]$Dir)
$ErrorActionPreference = 'Stop'
function Load($file, $names, $assign) { $tk = $null; $er = $null
  $ast = [Management.Automation.Language.Parser]::ParseFile((Join-Path $Dir $file), [ref]$tk, [ref]$er); if ($er.Count) { throw "parse $file" }
  foreach ($n in $names) { $f = @($ast.FindAll({ param($x) $x -is [Management.Automation.Language.FunctionDefinitionAst] -and $x.Name -eq $n }, $true))
    if ($f.Count -ne 1) { throw "missing $n" }; . ([scriptblock]::Create($f[0].Extent.Text)) }
  foreach ($v in $assign) { $a = @($ast.FindAll({ param($x) $x -is [Management.Automation.Language.AssignmentStatementAst] -and $x.Left.Extent.Text -eq $v }, $true))
    if ($a.Count -ne 1) { throw "missing $v" }; . ([scriptblock]::Create($a[0].Extent.Text)) } }
. Load 'cutover.ps1' @('Known') @()
. Load 'native-test.ps1' @('Unobserved','Preservation','AllTrue') @('$GROUP')
function Snap($o) { $s = [ordered]@{ node = [ordered]@{ cmd = @(@{ pid = 1 }); agent = @(@{ pid = 2 }) }; privacy = @([ordered]@{ pid = 3; start = 's' }); manager = '4@m'
  tasks = 'Network=Running,Node=Running'; vmCount = 10; vmSha = 'v'; hypervCount = 9; hypervSha = 'h'; files = [ordered]@{ a = 'x' } }
  foreach ($k in $o.Keys) { $s[$k] = $o[$k] }; $s }
$r = [ordered]@{}
$k = Preservation (Snap @{}) (Snap @{}); $r.fullObservationPreserved = (AllTrue $k) -and (Unobserved (Snap @{})).Count -eq 0
$r.changedValueIsFalse = ((Preservation (Snap @{}) (Snap @{ manager = '5@m' })).manager -eq $false) -and -not (AllTrue (Preservation (Snap @{}) (Snap @{ manager = '5@m' })))
$cases = [ordered]@{ vmUnavailable = @(@{ vmCount = -1; vmSha = 'u' }, 'managerVms', 'vmCount'); hypervUnavailable = @(@{ hypervCount = -1; hypervSha = 'u' }, 'hyperv', 'hypervSha')
  managerUnavailable = @(@{ manager = 'unavailable' }, 'manager', 'manager'); managerEmpty = @(@{ manager = '' }, 'manager', 'manager')
  privacyNone = @(@{ privacy = @() }, 'privacy', 'privacy'); privacyTwo = @(@{ privacy = @([ordered]@{ pid = 3 }, [ordered]@{ pid = 9 }) }, 'privacy', 'privacy'); tasksNone = @(@{ tasks = '' }, 'tasks', 'tasks') }
foreach ($name in $cases.Keys) { $o, $g, $field = $cases[$name]
  # identical missing observation before AND after must NOT compare as preserved
  $both = Preservation (Snap $o) (Snap $o); $after = Preservation (Snap @{}) (Snap $o)
  $r[$name] = (Unobserved (Snap $o)).Contains($g) -and ([string]$both[$field]).StartsWith('UNOBSERVED: before') -and ([string]$after[$field]).StartsWith('UNOBSERVED: after') -and
              -not (AllTrue $both) -and -not (AllTrue $after) }
$r.errorStringIsNotTrue = -not (AllTrue ([ordered]@{ a = $true; b = 'ERROR: x' }))
$pass = @($r.Values | Where-Object { $_ -ne $true }).Count -eq 0
[ordered]@{ passed = @($r.Values | Where-Object { $_ -eq $true }).Count; total = $r.Count; results = $r } | ConvertTo-Json -Compress
if (-not $pass) { exit 3 }
