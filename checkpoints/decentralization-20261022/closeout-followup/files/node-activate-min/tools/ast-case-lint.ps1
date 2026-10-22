# ast-case-lint.ps1 - case-insensitive variable collisions by the PowerShell AST (VariableExpressionAst names; comments and
# string literals cannot hide code from it, unlike the regex lint). Reports each colliding spelling with the functions using it.
param([string[]]$Path)
$ErrorActionPreference = 'Stop'
foreach ($f in $Path) {
  $t = $null; $e = $null; $ast = [Management.Automation.Language.Parser]::ParseFile((Resolve-Path $f), [ref]$t, [ref]$e)
  if ($e.Count) { throw "parse errors in $f" }
  $m = [Collections.Generic.Dictionary[string, object]]::new([StringComparer]::Ordinal)
  foreach ($v in $ast.FindAll({ param($n) $n -is [Management.Automation.Language.VariableExpressionAst] }, $true)) {
    $n = $v.VariablePath.UserPath -replace '^(script|global|local):', ''; if ($n -in '_', 'null', 'true', 'false') { continue }
    $fn = $v; while ($fn -and -not ($fn -is [Management.Automation.Language.FunctionDefinitionAst])) { $fn = $fn.Parent }
    $k = $n.ToLower(); if (-not $m.ContainsKey($k)) { $m[$k] = [Collections.Generic.Dictionary[string, object]]::new([StringComparer]::Ordinal) }
    if (-not $m[$k].ContainsKey($n)) { $m[$k][$n] = [Collections.Generic.HashSet[string]]::new() }
    [void]$m[$k][$n].Add($(if ($fn) { $fn.Name } else { '<script>' })) }
  $c = [ordered]@{}; foreach ($k in ($m.Keys | Sort-Object)) { if ($m[$k].Count -gt 1) { $c[$k] = @(foreach ($s in $m[$k].Keys) { '$' + $s + ' in ' + (@($m[$k][$s] | Sort-Object) -join ',') }) } }
  [ordered]@{ file = (Split-Path -Leaf $f); collisions = $c } | ConvertTo-Json -Depth 5 -Compress }
