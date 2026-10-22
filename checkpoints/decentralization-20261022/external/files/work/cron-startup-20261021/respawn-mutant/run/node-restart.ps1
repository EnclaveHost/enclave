# node-restart.ps1 - restart ONLY the Enclave node agent (task \Enclave\Node) so run-node.cmd re-reads node-config.cmd
# (its `call` runs once, BEFORE the restart loop: killing node.exe alone would bring the agent back on the OLD settings).
# Executed from hash-verified bytes (activate.py), never via -File: no execution-policy change. PowerShell 5.1.
# Never touches the manager (Shield), Network, Relay, Card, NetworkChecker or any VM. Output: ONE line of JSON (PIDs,
# start times, booleans, counts, measured times); never a command line or a config value.
#   -Mode identify   read-only: the exact task + action, run-node.cmd hash, the run-node cmd.exe + agent node.exe and the
#                    processes of every OTHER \Enclave\ task (PID + creation time), the manager, the VM id set
#   -Mode restart    refuses unless EVERY identity matches the caller's pins (agent PID+start, cmd PID+start, manager
#                    PID+start, run-node.cmd sha). Identity (PID + creation time + parent + command-line pattern) is
#                    RE-VERIFIED immediately before Stop-ScheduledTask and before any Stop-Process (a reused PID is never
#                    killed). Then: Node task stopped -> its cmd.exe gone (<= 30 s) -> the old agent gone (<= 30 s; if it
#                    outlived its cmd.exe it is stopped only after re-verification) -> Start-ScheduledTask Node -> a NEW agent
#                    whose parent is the NEW run-node cmd.exe -> 127.0.0.1:9600 answers, all within -MaxPauseSec of the
#                    stop (default 120) or the run reports FAILED_PAUSE_BOUND. Then: manager, every other task's processes
#                    and the manager's VM id set compared with before. Whole run bounded by -BoundSec (default 240).
param([ValidateSet('identify','restart')][string]$Mode = 'identify', [string]$ExpectRunNodeSha = '',
      [int]$ExpectAgentPid = 0, [string]$ExpectAgentStart = '', [int]$ExpectCmdPid = 0, [string]$ExpectCmdStart = '',
      [int]$ExpectManagerPid = 0, [string]$ExpectManagerStart = '', [int]$MaxPauseSec = 120, [int]$BoundSec = 240)
$ErrorActionPreference = 'Stop'
$PD = 'C:\ProgramData\Enclave'; $RUN = Join-Path $PD 'run-node.cmd'; $T0 = Get-Date
$AGENT_PAT = '*\control\windows\node\agent.mjs*'; $RUN_PAT = '*\Enclave\run-node.cmd*'
function Left { $BoundSec - ((Get-Date) - $T0).TotalSeconds }
function Done($o) { $o.mode = $Mode; $o.seconds = [math]::Round(((Get-Date) - $T0).TotalSeconds, 1); $o | ConvertTo-Json -Compress -Depth 5; exit 0 }
function Sha($p) { if (Test-Path -LiteralPath $p) { (Get-FileHash -Algorithm SHA256 -LiteralPath $p).Hash.ToLower() } else { 'absent' } }
function Utc($p) { $p.CreationDate.ToUniversalTime().ToString('o') }
function ById($procId) { Get-CimInstance Win32_Process -Filter "ProcessId=$procId" -OperationTimeoutSec 20 }
function Same($procId, $start, $name, $pat, $parent) {          # identity now == recorded identity (PID reuse proof)
  $p = ById $procId
  return [bool]($p -and (Utc $p) -eq $start -and [string]$p.Name -eq $name -and [string]$p.CommandLine -like $pat -and ($parent -eq 0 -or [int]$p.ParentProcessId -eq $parent)) }
function Procs {
  $cm = @(Get-CimInstance Win32_Process -Filter "Name='cmd.exe'" -OperationTimeoutSec 20 | Where-Object { [string]$_.CommandLine -like $RUN_PAT })
  $nd = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -OperationTimeoutSec 20 | Where-Object { [string]$_.CommandLine -like $AGENT_PAT })
  [ordered]@{ cmd = @($cm | ForEach-Object { [ordered]@{ pid = [int]$_.ProcessId; start = (Utc $_) } })
              agent = @($nd | ForEach-Object { [ordered]@{ pid = [int]$_.ProcessId; parent = [int]$_.ParentProcessId; start = (Utc $_) } }) } }
function Manager {
  $c = @(Get-NetTCPConnection -LocalPort 8091 -State Listen -ErrorAction SilentlyContinue)
  if ($c.Count -ne 1) { return [ordered]@{ pid = 0; start = ''; listeners = $c.Count } }
  $p = ById $c[0].OwningProcess; [ordered]@{ pid = [int]$p.ProcessId; start = (Utc $p); listeners = 1 } }
function Others {   # every OTHER \Enclave\ task: state + the PIDs/starts of the processes running its action's .cmd file
  $all = @(Get-CimInstance Win32_Process -OperationTimeoutSec 30)
  @(Get-ScheduledTask -TaskPath '\Enclave\' | Where-Object { $_.TaskName -ne 'Node' } | Sort-Object TaskName | ForEach-Object {
    $f = [regex]::Match([string]$_.Actions[0].Arguments, '[^"\\]+\.(cmd|ps1|mjs|exe)').Value
    $ps = @(if ($f) { $all | Where-Object { [string]$_.CommandLine -like "*$f*" } | Sort-Object ProcessId | ForEach-Object { "$($_.ProcessId)@$(Utc $_)" } })
    "$($_.TaskName)=$([string]$_.State):$($ps -join '+')" }) -join ',' }
function Vms { try { @((Invoke-RestMethod -UseBasicParsing -TimeoutSec 15 -Uri 'http://127.0.0.1:8091/vms').vms | ForEach-Object { [string]$_.id } | Sort-Object) -join ',' } catch { 'unavailable' } }
function AgentUp { try { (Invoke-WebRequest -UseBasicParsing -TimeoutSec 5 -Uri 'http://127.0.0.1:9600/v1/deployments').StatusCode -eq 200 } catch { $false } }

$t = Get-ScheduledTask -TaskPath '\Enclave\' -TaskName 'Node'; $a = $t.Actions[0]
$o = [ordered]@{ taskState = [string]$t.State; actionExact = ([string]$a.Execute -eq 'cmd.exe' -and [string]$a.Arguments -eq ('/c "' + $RUN + '"') -and $t.Actions.Count -eq 1)
                 runNodeSha = (Sha $RUN); before = (Procs); manager = (Manager) }
if ($Mode -eq 'identify') { $o.others = (Others); $v = Vms; $o.vmCount = $(if ($v -eq 'unavailable') { -1 } elseif ($v) { ($v -split ',').Count } else { 0 }); $o.decision = 'identified'; Done $o }

# restart: every identity must match the caller's pins exactly
$b = $o.before; $why = @()
if (-not $o.actionExact) { $why += 'the Node task action is not exactly cmd.exe /c run-node.cmd' }
if ($o.runNodeSha -ne $ExpectRunNodeSha) { $why += 'run-node.cmd is not the pinned file' }
if ($b.cmd.Count -ne 1 -or $b.agent.Count -ne 1) { $why += "expected one run-node cmd and one agent, found $($b.cmd.Count)/$($b.agent.Count)" }
else {
  if ($b.cmd[0].pid -ne $ExpectCmdPid -or $b.cmd[0].start -ne $ExpectCmdStart) { $why += 'the run-node cmd.exe is not the pinned PID+start' }
  if ($b.agent[0].pid -ne $ExpectAgentPid -or $b.agent[0].start -ne $ExpectAgentStart -or $b.agent[0].parent -ne $b.cmd[0].pid) { $why += 'the agent is not the pinned PID+start+parent' } }
if ($o.manager.pid -ne $ExpectManagerPid -or $o.manager.start -ne $ExpectManagerStart) { $why += 'the manager is not the pinned PID+start' }
if ($MaxPauseSec -lt 30 -or $MaxPauseSec -gt 180) { $why += '-MaxPauseSec must be 30..180' }
if ($why.Count) { $o.decision = 'refused: ' + ($why -join '; '); Done $o }
$others0 = Others; $vms0 = Vms
# re-verify the exact identities immediately before acting
if (-not (Same $ExpectCmdPid $ExpectCmdStart 'cmd.exe' $RUN_PAT 0) -or -not (Same $ExpectAgentPid $ExpectAgentStart 'node.exe' $AGENT_PAT $ExpectCmdPid)) {
  $o.decision = 'refused: identity changed between the checks; nothing stopped'; Done $o }
$stop = Get-Date; $o.stoppedAt = $stop.ToUniversalTime().ToString('o')
Stop-ScheduledTask -TaskPath '\Enclave\' -TaskName 'Node'
$d = (Get-Date).AddSeconds([math]::Min(30, (Left)))
while ((Same $ExpectCmdPid $ExpectCmdStart 'cmd.exe' $RUN_PAT 0) -and (Get-Date) -lt $d) { Start-Sleep -Milliseconds 500 }
if (Same $ExpectCmdPid $ExpectCmdStart 'cmd.exe' $RUN_PAT 0) { $o.decision = 'FAILED: the run-node cmd.exe did not stop; nothing started (root decides)'; Done $o }
$d = (Get-Date).AddSeconds([math]::Min(30, (Left)))
while ((Same $ExpectAgentPid $ExpectAgentStart 'node.exe' $AGENT_PAT $ExpectCmdPid) -and (Get-Date) -lt $d) { Start-Sleep -Milliseconds 500 }
if (Same $ExpectAgentPid $ExpectAgentStart 'node.exe' $AGENT_PAT $ExpectCmdPid) {
  # it outlived its cmd.exe: re-verified identity (PID + creation time + parent + agent.mjs) immediately before the stop
  Stop-Process -Id $ExpectAgentPid -Force; $o.agentStoppedByVerifiedPid = $true
  $d = (Get-Date).AddSeconds(10); while ((Same $ExpectAgentPid $ExpectAgentStart 'node.exe' $AGENT_PAT $ExpectCmdPid) -and (Get-Date) -lt $d) { Start-Sleep -Milliseconds 500 }
  if (Same $ExpectAgentPid $ExpectAgentStart 'node.exe' $AGENT_PAT $ExpectCmdPid) { $o.decision = 'FAILED: the old agent is still running; nothing started (root decides)'; Done $o } }
Start-ScheduledTask -TaskPath '\Enclave\' -TaskName 'Node'
$o.startedAt = (Get-Date).ToUniversalTime().ToString('o')
$limit = $stop.AddSeconds($MaxPauseSec); $n = $null
while (-not $n -and (Get-Date) -lt $limit -and (Left) -gt 0) {
  $q = Procs; $c1 = @($q.cmd | Where-Object { $_.pid -ne $ExpectCmdPid })
  $n = @($q.agent | Where-Object { $_.pid -ne $ExpectAgentPid -and $c1.Count -eq 1 -and $_.parent -eq $c1[0].pid }) | Select-Object -First 1
  if (-not $n) { Start-Sleep -Milliseconds 500 } }
$up = $false
while ($n -and -not $up -and (Get-Date) -lt $limit -and (Left) -gt 0) { $up = AgentUp; if (-not $up) { Start-Sleep -Seconds 1 } }
$o.agentUpAt = $(if ($up) { (Get-Date).ToUniversalTime().ToString('o') } else { $null })
$o.ingressPauseSec = [math]::Round(((Get-Date) - $stop).TotalSeconds, 1)
$o.after = (Procs); $m1 = Manager
$o.newAgent = [bool]$n; $o.agentAnswers = $up
$o.managerUnchanged = ($m1.pid -eq $o.manager.pid -and $m1.start -eq $o.manager.start)
$o.otherTasksUnchanged = ((Others) -eq $others0); $o.vmSetUnchanged = ((Vms) -eq $vms0)
$o.decision = $(if (-not $n -or -not $up) { "FAILED_PAUSE_BOUND: no answering new agent within $MaxPauseSec s of the stop (the task WAS started)" }
                elseif ($o.managerUnchanged -and $o.otherTasksUnchanged -and $o.vmSetUnchanged) { 'restarted: node agent only' }
                else { 'restarted, CHECK: see managerUnchanged / otherTasksUnchanged / vmSetUnchanged' }); Done $o
