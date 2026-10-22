param([string]$Source)
$ErrorActionPreference='Stop';$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile((Resolve-Path $Source),[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'parse errors'}
foreach($name in 'AgentUp','HostState') {
 $f=@($ast.FindAll({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $name},$true))
 if($f.Count -ne 1){throw 'function missing'}
 . ([scriptblock]::Create($f[0].Extent.Text))
}
function Assert($v,$m){if(-not $v){throw $m}}
$TR='';$script:clock=[datetime]::UtcNow;$script:listenerSec=10;$script:httpSec=4;$script:httpCalls=0;$script:readyCalls=0
function Get-Date{$script:clock}
function Lim($s){$s}
function IsoMs($s){0}
function LeaseReady($h,$start){$script:readyCalls++;$true}
function Listeners($port,$s){$script:listenerBudget=$s;$script:clock=$script:clock.AddSeconds($script:listenerSec);[pscustomobject]@{OwningProcess=7}}
function Query($body,$s){$script:httpBudget=$s;$script:httpCalls++;$script:clock=$script:clock.AddSeconds($script:httpSec);& $body}
function Invoke-RestMethod{param($Uri,[switch]$UseBasicParsing,$TimeoutSec)
 [pscustomobject]@{deployments=@([pscustomobject]@{id='app';status='running';leaseUntil=12345;configCid='PRIVATE'});leaseReadiness=@{sequence=7};privateData='PRIVATE'}
}
$r=HostState 9
Assert ($r.deployments.Count -eq 1 -and @($r.deployments[0].Keys).Count -eq 3 -and -not $r.deployments[0].Contains('configCid') -and $r.leaseReadiness.sequence -eq 7 -and -not $r.Contains('privateData')) 'projection leaked private fields or lost readiness'
$script:httpCalls=0;$script:readyCalls=0
Assert (AgentUp @{pid=7;start='any'} 15) 'healthy combined path refused'
Assert ($script:listenerBudget -eq 15 -and $script:httpBudget -eq 5 -and $script:readyCalls -eq 1) 'HTTP received a fresh phase budget'
$script:httpSec=6;$script:readyCalls=0
Assert (-not (AgentUp @{pid=7;start='any'} 15) -and $script:readyCalls -eq 0) 'late HTTP response passed readiness'
$script:listenerSec=16;$script:httpCalls=0
Assert (-not (AgentUp @{pid=7;start='any'} 15) -and $script:httpCalls -eq 0) 'late listener query launched HTTP'
$script:listenerSec=10;$script:httpSec=5;$script:readyCalls=0
Assert (-not (AgentUp @{pid=7;start='any'} 15) -and $script:readyCalls -eq 0) 'response at the deadline was accepted'
[ordered]@{passed=5;parseErrors=$errors.Count}|ConvertTo-Json -Compress
