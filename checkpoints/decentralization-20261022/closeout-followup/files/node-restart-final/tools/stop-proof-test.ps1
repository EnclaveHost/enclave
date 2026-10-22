# stop-proof-test.ps1 - the rpc-integrated stop-proof test (cutover-review/rpc-integrated/tools/stop-proof-test.ps1), its StopNode part
# only (this helper has no Revert): one combined pre-stop snapshot, a complete stop proof, identity uncertainty never mutates.
param([string]$Source)
$ErrorActionPreference='Stop';$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile((Resolve-Path $Source),[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'parse errors'}
$f=@($ast.FindAll({param($n)$n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'StopNode'},$true));if($f.Count -ne 1){throw 'function missing'}
. ([scriptblock]::Create($f[0].Extent.Text))
function Assert($v,$m){if(-not $v){throw $m}}
$cmd=@{pid=10;start='cmd-start'};$agent=@{pid=11;start='agent-start';parent=10}
$script:Fwd=$true;$script:phase='pins';$RUN_PAT='run';$AGENT_PAT='agent'
function NodeProcs{$v=$script:rows[$script:reads];$script:reads++;$v}
function NodeTask($action){$script:taskCalls++;Assert ($action -eq 'Stop') 'unexpected task action'}
function WaitNodeGone{$true}
function BeforeStop{$script:before++;$script:refusal}
function NeedForward{}
function Now{'test-proof-time'}
function Same{$true}
function Reset($after,$initial){$script:rows=@($initial,$after);$script:reads=0;$script:taskCalls=0;$script:phase='pins';$script:Fwd=$true;$script:LastStopProofAt=$null;$script:before=0;$script:refusal=$null}
$initial=@{cmd=@($cmd);agent=@($agent)};$empty=@{cmd=@();agent=@()}
Reset $empty $initial
Assert ((StopNode $cmd $agent) -eq 'stopped' -and $script:reads -eq 2 -and $script:taskCalls -eq 1 -and $script:LastStopProofAt -eq 'test-proof-time' -and $script:before -eq 1 -and $script:phase -eq 'stopping') 'complete stop proof missing'
foreach($after in @(@{cmd=@(@{pid=20;start='new'});agent=@()},@{cmd=@();agent=@(@{pid=21;start='new';parent=20})})){
 Reset $after $initial
 Assert ((StopNode $cmd $agent) -ne 'stopped' -and $null -eq $script:LastStopProofAt) 'surviving launcher or agent accepted as stopped'
}
foreach($bad in @(@{cmd=@($cmd,$cmd);agent=@($agent)},@{cmd=@($cmd);agent=@(@{pid=11;start='reused';parent=10})},@{cmd=@($cmd);agent=@(@{pid=11;start='agent-start';parent=99})},@{cmd=@();agent=@($agent)})){
 Reset $empty $bad
 Assert ((StopNode $cmd $agent) -eq 'identity changed; nothing stopped' -and $script:taskCalls -eq 0) 'identity uncertainty mutated the task'
}
Reset $empty $initial; $script:refusal='lease too short'
Assert ((StopNode $cmd $agent) -eq 'REFUSED: lease too short' -and $script:taskCalls -eq 0 -and $script:phase -eq 'pins') 'BeforeStop refusal still stopped the node'
[ordered]@{passed=8;parseErrors=$errors.Count}|ConvertTo-Json -Compress
