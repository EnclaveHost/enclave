# AST-extracted NATIVE-branch checks ($TR empty, Query/Invoke-BoundedQuery path) on a simulated clock. Not Windows evidence.
# Each reader costs 0.7 s; a reader is refused (as the real Query does) when its budget is < 2500 ms.
param([string]$Source)
$ErrorActionPreference = 'Stop'; $tokens = $null; $errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile((Resolve-Path $Source), [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw 'parse errors' }
foreach ($name in 'Iso','Lim','PollRoom','Query','Utc','ProcessRows','ById','Same','NodeProcs','Privacy','WaitNodeGone','StopNode','NodeStopped','RestartPrivacy','StartNode','Recovery') {
  $f = @($ast.FindAll({ param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $name }, $true))
  if ($f.Count -eq 1) { . ([scriptblock]::Create($f[0].Extent.Text)) } elseif ($name -ne 'PollRoom') { throw "function $name missing" } }
$TR = ''; $script:Fwd = $false; $script:phase = 'stopped'; $BoundSec = 100000; $RUN_PAT = '*\Enclave\run-node.cmd*'; $AGENT_PAT = '*\control\windows\node\agent.mjs*'
$LOCAL = 'local'; $CFG = 'cfg'; $LeaseEnd = $null
function Get-Date { $script:clock }
function Start-Sleep { param([int]$Seconds = 0, [int]$Milliseconds = 0) $script:clock = $script:clock.AddMilliseconds($Seconds * 1000 + $Milliseconds); Tick }
function Left { 100000 }
function Now { 'proof-time' }
function NowS { 0 }
function Sha($p) { 'sha' }
function NeedForward { }
function BeforeStop { $null }
function NodeTask($a, $l) { $script:tasks += @($a); if ($a -eq 'Stop') { $script:procs = @($script:procs | Where-Object { $_.Name -ne 'cmd.exe' }) } }
function Stop-Process { param($Id, [switch]$Force) $script:kills += @([int]$Id); if ($script:killable) { $script:procs = @($script:procs | Where-Object { $_.ProcessId -ne [int]$Id }) } }
function Tick { }
function Final($d, $o) { $script:final = $d; $script:finalObj = $o }
function Invoke-BoundedQuery([scriptblock]$Query, [int]$BudgetMs) {
  $code = $Query.ToString(); $script:clock = $script:clock.AddMilliseconds([math]::Min(700, $BudgetMs))
  if ($script:queryFails) { return [pscustomobject]@{ ok = $false; value = $null; reason = 'query process failed'; childExited = $true } }
  $rows = @($script:procs)
  if ($code -match 'ProcessId=(\d+)') { $rows = @($rows | Where-Object { $_.ProcessId -eq [int]$matches[1] }) }
  elseif ($code -match "Name='cmd.exe' OR Name='node.exe'") { $rows = @($rows | Where-Object { $_.Name -in 'cmd.exe','node.exe' }) }
  elseif ($code -match "Name='node.exe'") { $rows = @($rows | Where-Object { $_.Name -eq 'node.exe' }) }
  [pscustomobject]@{ ok = $true; value = @($rows); reason = $null; childExited = $true } }
function P($procId, $parent, $name, $cmd) { [pscustomobject]@{ ProcessId = $procId; ParentProcessId = $parent; Name = $name; CommandLine = $cmd; CreationDate = "2026-10-22T00:00:0$($procId % 10).0000000Z" } }
$cmdRow = P 10 1 'cmd.exe' 'cmd.exe /c "C:\ProgramData\Enclave\run-node.cmd"'
$agentRow = P 11 10 'node.exe' '"node.exe" "C:\Program Files\Enclave\control\windows\node\agent.mjs"'
$privRow = P 30 3 'node.exe' '"node.exe" "C:\Program Files\Enclave\network\privacy-agent.mjs"'
function Reset { $script:clock = [datetime]::new(2026,10,22,0,0,0,[DateTimeKind]::Utc); $script:tasks = @(); $script:kills = @(); $script:killable = $true
  $script:queryFails = $false; $script:QueryCleanupFailed = $false; $script:final = $null; $script:finalObj = $null; $script:LastStopProofAt = $null }
$results = [ordered]@{}
function Check($name, [scriptblock]$body) { Reset; try { $v = & $body; $results[$name] = [bool]$v } catch { $results[$name] = 'THREW: ' + $_.Exception.Message } }
$pin = [ordered]@{ pid = 11; start = '2026-10-22T00:00:01.0000000Z' }; $cpin = [ordered]@{ pid = 10; start = '2026-10-22T00:00:00.0000000Z' }
Check 'waitNodeGoneEndsNotProvenInsteadOfThrowing' { $script:procs = @($agentRow); $t0 = $script:clock
  $r = WaitNodeGone $pin 'node.exe' $AGENT_PAT 10 30; ($r -eq $false) -and (($script:clock - $t0).TotalSeconds -le 30) }
Check 'stopNodeReachesTheForcedAgentKill' { $script:procs = @($cmdRow, $agentRow, $privRow); $script:killable = $true
  $r = StopNode $cpin $pin; ($r -eq 'stopped') -and ($script:kills -contains 11) -and (($script:tasks -join ',') -eq 'Stop') }
Check 'stopNodeUnkillableAgentIsNotProvenNoThrow' { $script:procs = @($cmdRow, $agentRow, $privRow); $script:killable = $false; $t0 = $script:clock
  $r = StopNode $cpin $pin; ($r -eq 'the old agent did not verifiably stop inside its budget') -and (($script:clock - $t0).TotalSeconds -le 136) }
Check 'restartPrivacyWithoutRespawnReturnsNull' { $script:procs = @($privRow); $t0 = $script:clock
  $r = RestartPrivacy ([ordered]@{ pid = 30; start = '2026-10-22T00:00:00.0000000Z' }) 90; ($null -eq $r) -and ($script:kills -contains 30) -and (($script:clock - $t0).TotalSeconds -le 90) }
Check 'startNodeWithoutProcessesReturnsNull' { $script:procs = @(); $t0 = $script:clock
  $r = StartNode 150; ($null -eq $r) -and (($script:tasks -join ',') -eq 'Start') -and (($script:clock - $t0).TotalSeconds -le 150) }
Check 'recoveryJournalsEvenWhenItsReaderFails' { $script:procs = @(); $script:QueryCleanupFailed = $true
  Recovery 'test' ([ordered]@{}); ($script:final -eq 'RECOVERY_REQUIRED: test') -and ([string]$script:finalObj.nodeStopped -like 'unknown:*') }
$pass = @($results.Values | Where-Object { $_ -eq $true }).Count
[ordered]@{ passed = $pass; total = $results.Count; parseErrors = $errors.Count; results = $results } | ConvertTo-Json -Compress -Depth 4
if ($pass -ne $results.Count) { exit 3 }
