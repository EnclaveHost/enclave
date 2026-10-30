param([string]$Script,[string]$Fixture)
$ErrorActionPreference='Stop';$tokens=$null;$errors=$null
$ast=[System.Management.Automation.Language.Parser]::ParseFile($Script,[ref]$tokens,[ref]$errors)
if($errors.Count){throw ($errors|Out-String)}
foreach($name in 'ReadinessNumber','LeaseReady'){
 $f=@($ast.FindAll({param($n)$n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $name},$true))
 if($f.Count-ne 1){throw "missing $name"};. ([scriptblock]::Create($f[0].Extent.Text))
}
function NowMs {[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()}
function NowS {[DateTimeOffset]::UtcNow.ToUnixTimeSeconds()}
$v=Get-Content -LiteralPath $Fixture -Raw|ConvertFrom-Json;$PRM=$v.params
$ok=LeaseReady $v.state $v.sinceMs
[pscustomobject]@{ready=[bool]$ok}|ConvertTo-Json -Compress
