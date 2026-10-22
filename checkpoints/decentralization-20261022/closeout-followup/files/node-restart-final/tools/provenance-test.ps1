# provenance-test.ps1 - every function the composed helper marks "verbatim df2e58f2" is BYTE-IDENTICAL (PowerShell AST extent text)
# to the same function in the root-reviewed node-hold-cutover.ps1 df2e58f2; the modified/new ones are listed, never silently equal.
param([string]$Helper, [string]$Source, [string]$Provenance)
$ErrorActionPreference = 'Stop'
function Funcs($path) { $t = $null; $e = $null; $ast = [Management.Automation.Language.Parser]::ParseFile((Resolve-Path $path), [ref]$t, [ref]$e)
  if ($e.Count) { throw "parse errors in $path" }
  $m = @{}; foreach ($f in $ast.FindAll({ param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] }, $true)) { if ($m.ContainsKey($f.Name)) { throw "duplicate $($f.Name)" }; $m[$f.Name] = $f.Extent.Text }
  return $m }
$h = Funcs $Helper; $s = Funcs $Source; $p = Get-Content -Raw $Provenance | ConvertFrom-Json
$verbatim = @($p.verbatim.PSObject.Properties.Name); $bad = @()
foreach ($n in $verbatim) { if (-not $h.ContainsKey($n) -or $h[$n] -ne $s[$n]) { $bad += $n } }
foreach ($n in @($p.modified)) { if (-not $h.ContainsKey($n) -or -not $s.ContainsKey($n) -or $h[$n] -eq $s[$n]) { $bad += "modified:$n" } }
foreach ($n in @($p.new)) { if (-not $h.ContainsKey($n) -or $s.ContainsKey($n)) { $bad += "new:$n" } }
$unlisted = @($h.Keys | Where-Object { $_ -notin $verbatim -and $_ -notin @($p.modified) -and $_ -notin @($p.new) })
if ($bad.Count -or $unlisted.Count) { throw "provenance: bad=$($bad -join ',') unlisted=$($unlisted -join ',')" }
[ordered]@{ verbatim = $verbatim.Count; modified = @($p.modified).Count; new = @($p.new).Count; passed = $true } | ConvertTo-Json -Compress
