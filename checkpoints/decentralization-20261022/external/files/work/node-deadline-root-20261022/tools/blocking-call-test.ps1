param([string]$Script)
$ErrorActionPreference = 'Stop'
$tokens = $null; $errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($Script, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw ($errors | Out-String) }
foreach ($name in 'StartNode','RestartPrivacy','WaitNodeGone') {
 $f = @($ast.FindAll({ param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $name }, $true))
 if ($f.Count -ne 1) { throw "expected one $name definition" }
 . ([scriptblock]::Create($f[0].Extent.Text))
}
$global:clock = [datetime]'2026-10-21T22:00:00Z'; $Fwd = $true
function Get-Date { $global:clock }
function Lim($n) { [math]::Min($n,$global:budget) }
function ForwardLeft { 100 }
function Left { 100 }
function Start-Sleep { param($Seconds=0,$Milliseconds=0) $global:clock=$global:clock.AddSeconds($Seconds + $Milliseconds/1000) }
function Start-ScheduledTask { param($TaskPath,$TaskName) $global:starts++ }
function Stop-Process { param($Id,[switch]$Force) $global:stops++ }
function NodeProcs {
 if ($global:mode -eq 'process-delay') { $global:clock=$global:clock.AddSeconds(5) }
 @{cmd=@(@{pid=1;start='s'});agent=@(@{pid=2;parent=1;start='s'})}
}
function AgentUp { if ($global:mode -eq 'http-delay') { $global:clock=$global:clock.AddSeconds(5) }; $true }
function Privacy { $global:clock=$global:clock.AddSeconds(5); @{pid=3;start='s'} }
$global:starts=0; $global:stops=0; $global:budget=100
function Same { param($procId,$start,$name,$pat,$parent) if ($global:mode -ne 'instant-gone') { $global:clock=$global:clock.AddSeconds(5) }; $false }
$global:mode='process-delay'; if ($null -ne (StartNode 3)) { throw 'accepted process discovery completed after deadline' }
$global:mode='http-delay'; if ($null -ne (StartNode 3)) { throw 'accepted HTTP readiness completed after deadline' }
if ($null -ne (RestartPrivacy @{pid=3;start='s'} 3)) { throw 'accepted restart after expired identity check' }
if ($global:stops -ne 0) { throw 'stopped privacy agent after identity query consumed deadline' }
$global:mode='query-overrun'; if (WaitNodeGone @{pid=1;start='s'} 'node.exe' '*' 0 3) { throw 'accepted stop proof after deadline' }
$global:mode='instant-gone'; if (-not (WaitNodeGone @{pid=1;start='s'} 'node.exe' '*' 0 3)) { throw 'refused timely stop proof' }
$global:budget=0; $before=$global:starts
if ($null -ne (StartNode 3) -or $global:starts -ne $before) { throw 'started node with no budget' }
'PASS: 6 blocking-call/deadline assertions (process, HTTP, privacy, late stop proof, timely stop proof, no-budget start)'
