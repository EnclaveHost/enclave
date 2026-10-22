param([string]$Script)
$ErrorActionPreference='Stop'
$t=$null;$e=$null;$ast=[System.Management.Automation.Language.Parser]::ParseFile($Script,[ref]$t,[ref]$e)
if($e.Count){throw ($e|Out-String)}
foreach($name in 'ReadinessNumber','LeaseReady') {
 $f=@($ast.FindAll({param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $name},$true));if($f.Count-ne 1){throw "missing $name"}
 . ([scriptblock]::Create($f[0].Extent.Text))
}
function NowMs {1000000}
function NowS {1000}
$PRM=@{expectedIds=@('a','b');runner='runner';lease=@{marginSec=180}}
function Good {
 [pscustomobject]@{deployments=@('a','b'|ForEach-Object{[pscustomobject]@{id=$_;status='running';leaseUntil=1500}})
 leaseReadiness=[pscustomobject]@{sequence=1;startedAt=997000;completedAt=999000;inFlight=$false
 deployments=@('a','b'|ForEach-Object{[pscustomobject]@{id=$_;sequence=1;status='ready';runner='runner';observedAt=998000;checkedAt=999000;leaseUntil=1500}})}}
}
if(-not(LeaseReady (Good) 996000)){throw 'refused valid evidence'}
$mutants=@(
 {param($h)$h.leaseReadiness=$null},
 {param($h)$h.leaseReadiness.sequence=$true},
 {param($h)$h.leaseReadiness.startedAt='997000'},
 {param($h)$h.leaseReadiness.deployments[1].leaseUntil=[double]::PositiveInfinity;$h.deployments[1].leaseUntil=[double]::PositiveInfinity},
 {param($h)$h.leaseReadiness.deployments[1].checkedAt=[double]::NaN},
 {param($h)$h.leaseReadiness.deployments[1].sequence=1.1},
 {param($h)$h.leaseReadiness.inFlight=$true},
 {param($h)$h.leaseReadiness.startedAt=995000},
 {param($h)$h.leaseReadiness.completedAt=994000},
 {param($h)$h.leaseReadiness.completedAt=1000001},
 {param($h)$h.leaseReadiness.sequence=0},
 {param($h)$h.leaseReadiness.deployments=@($h.leaseReadiness.deployments[0])},
 {param($h)$h.leaseReadiness.deployments+= $h.leaseReadiness.deployments[0]},
 {param($h)$h.deployments=@($h.deployments[0])},
 {param($h)$h.deployments[1].status='held'},
 {param($h)$h.leaseReadiness.deployments[1].status='pending'},
 {param($h)$h.leaseReadiness.deployments[1].status='not-ready'},
 {param($h)$h.leaseReadiness.deployments[1].sequence=2},
 {param($h)$h.leaseReadiness.deployments[1].runner='other'},
 {param($h)$h.leaseReadiness.deployments[1].observedAt=996000},
 {param($h)$h.leaseReadiness.deployments[1].checkedAt=997000},
 {param($h)$h.leaseReadiness.deployments[1].checkedAt=1000000},
 {param($h)$h.leaseReadiness.deployments[1].leaseUntil=1501},
 {param($h)$h.leaseReadiness.deployments[1].leaseUntil=1180;$h.deployments[1].leaseUntil=1180}
)
$i=0;foreach($m in $mutants){$h=Good;& $m $h;if(LeaseReady $h 996000){throw "accepted invalid fixture $i"};$i++}
"PASS: valid evidence and $i negative readiness cases"
