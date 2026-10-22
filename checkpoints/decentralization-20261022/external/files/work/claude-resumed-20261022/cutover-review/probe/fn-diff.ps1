param([string]$PathOld, [string]$PathNew)
function F($p) { $t=$null;$e=$null; $ast=[Management.Automation.Language.Parser]::ParseFile($p,[ref]$t,[ref]$e); $h=@{}; foreach($f in $ast.FindAll({param($x) $x -is [Management.Automation.Language.FunctionDefinitionAst]},$true)){ $h[$f.Name]=$f.Extent.Text }; $h }
$fo=F $PathOld; $fn=F $PathNew
[ordered]@{ changed=@($fn.Keys|Where-Object{$fo.ContainsKey($_) -and $fo[$_] -ne $fn[$_]}|Sort-Object); added=@($fn.Keys|Where-Object{-not $fo.ContainsKey($_)}|Sort-Object); removed=@($fo.Keys|Where-Object{-not $fn.ContainsKey($_)}|Sort-Object); unchangedCount=@($fn.Keys|Where-Object{$fo.ContainsKey($_) -and $fo[$_] -eq $fn[$_]}).Count }|ConvertTo-Json -Compress
