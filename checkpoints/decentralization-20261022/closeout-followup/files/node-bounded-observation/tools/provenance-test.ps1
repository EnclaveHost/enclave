# provenance-test.ps1 - by the PowerShell AST (function extent text): every 'verbatim' function of node-pair-activate.ps1 is
# BYTE-IDENTICAL to df2e58f2; every 'reused7ac1' one to the frozen node-pair-activate.ps1 7ac1d873; every 'modified7ac1' one
# exists in 656d and differs; every 'new' one exists in neither; no function is unlisted.
param([string]$Helper, [string]$Source, [string]$Frozen, [string]$Provenance)
$ErrorActionPreference = 'Stop'
function Funcs($path) { $t = $null; $e = $null; $ast = [Management.Automation.Language.Parser]::ParseFile((Resolve-Path $path), [ref]$t, [ref]$e)
  if ($e.Count) { throw "parse errors in $path" }
  $m = @{}; foreach ($f in $ast.FindAll({ param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] }, $true)) { if ($m.ContainsKey($f.Name)) { throw "duplicate $($f.Name)" }; $m[$f.Name] = $f.Extent.Text }
  return $m }
$h = Funcs $Helper; $s = Funcs $Source; $z = Funcs $Frozen; $p = Get-Content -Raw $Provenance | ConvertFrom-Json
$verbatim = @($p.verbatim.PSObject.Properties.Name); $bad = @()
foreach ($n in $verbatim) { if (-not $h.ContainsKey($n) -or $h[$n] -ne $s[$n]) { $bad += "verbatim:$n" } }
foreach ($n in @($p.reused7ac1)) { if (-not $h.ContainsKey($n) -or -not $z.ContainsKey($n) -or $h[$n] -ne $z[$n]) { $bad += "reused:$n" } }
foreach ($n in @($p.modified7ac1)) { if (-not $h.ContainsKey($n) -or -not $z.ContainsKey($n) -or $h[$n] -eq $z[$n]) { $bad += "modified:$n" } }
foreach ($n in @($p.new)) { if (-not $h.ContainsKey($n) -or $s.ContainsKey($n) -or $z.ContainsKey($n)) { $bad += "new:$n" } }
$listed = $verbatim + @($p.reused7ac1) + @($p.modified7ac1) + @($p.new)
$unlisted = @($h.Keys | Where-Object { $_ -notin $listed })
if ($bad.Count -or $unlisted.Count) { throw "provenance: bad=$($bad -join ',') unlisted=$($unlisted -join ',')" }
[ordered]@{ verbatim = $verbatim.Count; reused7ac1 = @($p.reused7ac1).Count; modified7ac1 = @($p.modified7ac1).Count; new = @($p.new).Count; passed = $true } | ConvertTo-Json -Compress
