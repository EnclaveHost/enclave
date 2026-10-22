param([string]$Source)
$ErrorActionPreference='Stop';$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile((Resolve-Path $Source),[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'parse errors'}
foreach($name in 'StopNode','Revert'){
 $f=@($ast.FindAll({param($n)$n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $name},$true));if($f.Count -ne 1){throw 'function missing'}
 . ([scriptblock]::Create($f[0].Extent.Text))
}
function Assert($v,$m){if(-not $v){throw $m}}
$cmd=@{pid=10;start='cmd-start'};$agent=@{pid=11;start='agent-start';parent=10}
$script:Fwd=$true;$script:phase='pins';$RUN_PAT='run';$AGENT_PAT='agent'
function NodeProcs{$v=$script:rows[$script:reads];$script:reads++;$v}
function NodeTask($action){$script:taskCalls++;Assert ($action -eq 'Stop') 'unexpected task action'}
function WaitNodeGone{$true}
function BeforeStop{$null}
function NeedForward{}
function Now{'test-proof-time'}
# Same exists for the fallback identity check; the normal initial check must use the combined snapshot.
function Same{$true}
function Reset($after,$initial){$script:rows=@($initial,$after);$script:reads=0;$script:taskCalls=0;$script:phase='pins';$script:Fwd=$true;$script:LastStopProofAt=$null}
$initial=@{cmd=@($cmd);agent=@($agent)};$empty=@{cmd=@();agent=@()}
Reset $empty $initial
Assert ((StopNode $cmd $agent) -eq 'stopped' -and $script:reads -eq 2 -and $script:taskCalls -eq 1 -and $script:LastStopProofAt -eq 'test-proof-time') 'complete stop proof missing'
foreach($after in @(@{cmd=@(@{pid=20;start='new'});agent=@()},@{cmd=@();agent=@(@{pid=21;start='new';parent=20})})){
 Reset $after $initial
 Assert ((StopNode $cmd $agent) -ne 'stopped' -and $null -eq $script:LastStopProofAt) 'surviving launcher or agent accepted as stopped'
}
foreach($bad in @(@{cmd=@($cmd,$cmd);agent=@($agent)},@{cmd=@($cmd);agent=@(@{pid=11;start='reused';parent=10})},@{cmd=@($cmd);agent=@(@{pid=11;start='agent-start';parent=99})},@{cmd=@();agent=@($agent)})){
 Reset $empty $bad
 Assert ((StopNode $cmd $agent) -eq 'identity changed; nothing stopped' -and $script:taskCalls -eq 0) 'identity uncertainty mutated the task'
}
function LeaseLeft{500}
function RestoreOne($k){$script:restores+=@($k);'already before'}
function Sha($p){'old'}
function Privacy{@{pid=30;start='privacy-start'}}
function RestartPrivacy($p,$s){$p}
function IsoMs($s){0}
function FreshStatus{$script:plainVerified=$true;$true}
function NodeStopped{$script:postReads++;Assert ($script:plainVerified -and ($script:restores -join ',') -eq 'local,cfg') 'pre-start state read happened too early';$script:postEmpty}
function StartNode{$script:starts++;@{running=$true}}
function Recovery($why,$x){throw 'EXPECTED_RECOVERY'}
$before=@{local=@{before='old'};cfg=@{before='old'}};$LOCAL='local';$CFG='cfg'
foreach($ok in @($true,$false)){
 $script:rows=@($empty);$script:reads=0;$script:restores=@();$script:plainVerified=$false;$script:postReads=0;$script:postEmpty=$ok;$script:starts=0
 $failed=$false;try{$r=Revert 'test'}catch{Assert ($_.Exception.Message -eq 'EXPECTED_RECOVERY') $_.Exception.Message;$failed=$true}
 Assert ($script:reads -eq 1 -and $script:postReads -eq 1) 'redundant initial read or missing fresh pre-start read'
 Assert ($failed -eq (-not $ok) -and $script:starts -eq [int]$ok) 'node started despite new process after restore'
}
[ordered]@{passed=9;parseErrors=$errors.Count}|ConvertTo-Json -Compress
