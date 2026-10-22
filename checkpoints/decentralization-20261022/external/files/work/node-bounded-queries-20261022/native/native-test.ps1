param([string]$Stage)
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
$source=Join-Path $Stage 'cutover.ps1';$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile($source,[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'cutover parse errors'}
foreach($name in 'Invoke-BoundedQuery','Query','Utc','ProcessRows','ById','Same','NodeProcs','Privacy','Listeners','Manager','Iso') {
 $found=@($ast.FindAll({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $name},$true))
 if($found.Count -ne 1){throw "function missing or duplicated: $name"}
 . ([scriptblock]::Create($found[0].Extent.Text))
}
function Lim($s){[math]::Min(15,$s)}
$TR='';$RUN_PAT='*\Enclave\run-node.cmd*';$AGENT_PAT='*\control\windows\node\agent.mjs*'
$n=NodeProcs
if($n.cmd.Count -ne 1 -or $n.agent.Count -ne 1 -or $n.agent[0].parent -ne $n.cmd[0].pid){throw 'node process identity not unique'}
$c=$n.cmd[0];$a=$n.agent[0]
if(-not (Same $c.pid $c.start 'cmd.exe' $RUN_PAT 0)){throw 'cmd identity mismatch'}
if(-not (Same $a.pid $a.start 'node.exe' $AGENT_PAT $c.pid)){throw 'agent identity mismatch'}
if(Same $a.pid '2000-01-01T00:00:00.0000000Z' 'node.exe' $AGENT_PAT $c.pid){throw 'stale process start accepted'}
$l=@(Listeners 9600);if($l.Count -ne 1 -or $l[0].OwningProcess -ne $a.pid){throw 'listener owner mismatch'}
$p=@(Privacy);if($p.Count -ne 1){throw 'privacy agent not unique'}
$manager=Manager;if(-not $manager -or $manager -eq 'unavailable'){throw 'manager unavailable'}
[ordered]@{pass=$true;parseErrors=$errors.Count;node=$n;privacy=$p;manager=$manager;checks=7;readOnly=$true}|ConvertTo-Json -Depth 8 -Compress
