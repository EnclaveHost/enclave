param([string]$Source)
$ErrorActionPreference='Stop';$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile((Resolve-Path $Source),[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'parse errors'}
$f=@($ast.FindAll({param($n)$n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'NodeTask'},$true))
if($f.Count -ne 1){throw 'NodeTask missing'}
. ([scriptblock]::Create($f[0].Extent.Text))
function Assert($v,$m){if(-not $v){throw $m}}
$TR='';$script:limit=20;$script:calls=0;$script:reply=[pscustomobject]@{responseConfirmed=$true;outcome='response-confirmed';childExited=$true}
function Lim($s){[math]::Min($s,$script:limit)}
function Invoke-TaskCommand($action,$path,$name,$ms){$script:calls++;$script:seen=@($action,$path,$name,$ms);$script:reply}
NodeTask 'Stop'
Assert ($script:calls -eq 1 -and $script:seen[0] -eq 'Stop' -and $script:seen[1] -eq '\Enclave\' -and $script:seen[2] -eq 'Node' -and $script:seen[3] -eq 20000) 'request target or budget changed'
$script:limit=7;NodeTask 'Start' 12
Assert ($script:seen[0] -eq 'Start' -and $script:seen[3] -eq 7000) 'task got a fresh budget'
$script:limit=1;$before=$script:calls;$refused=$false;try{NodeTask 'Start'}catch{$refused=$true}
Assert ($refused -and $script:calls -eq $before -and -not $script:TaskMutationUnknown) 'request launched without cleanup reserve'
$script:limit=20;$script:reply=[pscustomobject]@{responseConfirmed=$false;outcome='unknown';childExited=$true;childId=77;timedOut=$true}
$refused=$false;try{NodeTask 'Start'}catch{$refused=$true}
Assert ($refused -and $script:TaskMutationUnknown -and $script:LastTaskCommand.childId -eq 77) 'unknown result lost'
$before=$script:calls;$refused=$false;try{NodeTask 'Stop'}catch{$refused=$true}
Assert ($refused -and $script:calls -eq $before) 'unknown task outcome was retried'
$traps=@($ast.EndBlock.Traps);if($traps.Count -ne 1){throw 'coordinator trap missing'}
$body=$traps[0].Body.Extent.Text;$body=$body.Substring(1,$body.Length-2)
$script:recoveryCount=0;$script:revertCount=0;$phase='node-started';$_=[pscustomobject]@{Exception=[Exception]::new('unknown')}
function Recovery($why,$x){$script:recoveryCount++;throw 'EXPECTED_UNCERTAIN_RECOVERY'}
function Revert($why){$script:revertCount++;throw 'UNSAFE_REVERT'}
$sentinel=$false;try{& ([scriptblock]::Create($body))}catch{$sentinel=$_.Exception.Message -eq 'EXPECTED_UNCERTAIN_RECOVERY'}
Assert ($sentinel -and $script:recoveryCount -eq 1 -and $script:revertCount -eq 0) 'coordinator mutated state after unknown task result'
[ordered]@{passed=6;parseErrors=$errors.Count}|ConvertTo-Json -Compress
