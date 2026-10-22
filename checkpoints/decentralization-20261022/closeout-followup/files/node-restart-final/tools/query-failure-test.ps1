param([string]$Source)
$ErrorActionPreference='Stop'
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile((Resolve-Path $Source),[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'parse errors'}
foreach($name in 'Query','AgentUp') {
 $f=@($ast.FindAll({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $name},$true))
 if($f.Count -ne 1){throw 'function missing'}
 . ([scriptblock]::Create($f[0].Extent.Text))
}
function Assert($v,$m){if(-not $v){throw $m}}
$script:lim=15;$script:calls=0;$script:reply=[pscustomobject]@{ok=$true;childExited=$true;value=42}
function Lim($s){[math]::Min($script:lim,$s)}
function Invoke-BoundedQuery($body,$ms){$script:calls++;$script:budget=$ms;$script:reply}
Assert ((Query {1} 4) -eq 42 -and $script:budget -eq 4000) 'stage budget not passed'
$script:lim=3;Assert ((Query {1} 14) -eq 42 -and $script:budget -eq 3000) 'global budget not passed'
$script:lim=1;$before=$script:calls;$refused=$false;try{$null=Query {1}}catch{$refused=$true}
Assert ($refused -and $script:calls -eq $before) 'query launched without cleanup budget'
$script:lim=15;$script:reply=[pscustomobject]@{ok=$false;childExited=$true;reason='query deadline reached'}
$refused=$false;try{$null=Query {1}}catch{$refused=$true}
Assert ($refused -and -not $script:QueryCleanupFailed) 'confirmed timeout not refused or permanently poisoned'
$script:reply=[pscustomobject]@{ok=$false;childExited=$false;reason='query child exit unconfirmed'}
$refused=$false;try{$null=Query {1}}catch{$refused=$true}
Assert ($refused -and $script:QueryCleanupFailed) 'unconfirmed child was not remembered'
$before=$script:calls;$refused=$false;try{$null=Query {1}}catch{$refused=$true}
Assert ($refused -and $script:calls -eq $before) 'unconfirmed cleanup launched another query'
function Listeners($port,$s){throw 'query child exit unconfirmed'}
$refused=$false;try{$null=AgentUp @{pid=1;start='2026-01-01'} 15}catch{$refused=$true}
Assert $refused 'AgentUp hid unconfirmed cleanup'
[ordered]@{passed=7;parseErrors=$errors.Count}|ConvertTo-Json -Compress
