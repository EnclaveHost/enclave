param([string]$Stage)
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
$tokens=$null;$errors=$null;$ast=[Management.Automation.Language.Parser]::ParseFile((Join-Path $Stage 'cutover.ps1'),[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'parse errors'}
foreach($name in 'Invoke-BoundedQuery','Query','HostState','Vms') {
 $f=@($ast.FindAll({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $name},$true))
 if($f.Count -ne 1){throw 'function missing'}
 . ([scriptblock]::Create($f[0].Extent.Text))
}
function Lim($s){[math]::Min(15,$s)}
$TR='';$sw=[Diagnostics.Stopwatch]::StartNew();$h=HostState 10;$hostMs=$sw.ElapsedMilliseconds
if(-not $h -or @($h.deployments).Count -lt 1){throw 'empty host state'}
foreach($d in $h.deployments){if((@($d.PSObject.Properties.Name|Sort-Object)-join ',') -ne 'id,leaseUntil,status'){throw 'host projection fields differ'}}
$sw.Restart();$v=Vms;$vmMs=$sw.ElapsedMilliseconds
if(-not $v -or $v -eq 'unavailable'){throw 'VM state unavailable'}
[ordered]@{pass=$true;parseErrors=$errors.Count;deploymentCount=@($h.deployments).Count;runningCount=@($h.deployments|Where-Object{$_.status -eq 'running'}).Count;hostQueryMs=$hostMs;vmCount=@($v -split ',').Count;vmQueryMs=$vmMs;applicationConfigExcluded=$true;readOnly=$true}|ConvertTo-Json -Compress
