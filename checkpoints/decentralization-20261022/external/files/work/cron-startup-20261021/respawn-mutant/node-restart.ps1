# node-restart.ps1 - restart ONLY the Enclave node agent (task \Enclave\Node) so run-node.cmd re-reads node-config.cmd
# (its `call` runs once, BEFORE the restart loop: killing node.exe alone would bring the agent back on the OLD settings).
# Never touches the manager (Shield), Network, Relay, Card or any VM. PowerShell 5.1. Output: ONE line of JSON
# (PIDs, start times, booleans, counts, the measured pause); never a command line or a config value.
#   -Mode identify   read-only: the exact task, action, run-node.cmd hash, the run-node cmd.exe + agent node.exe PIDs
#   -Mode restart    refuses unless EVERYTHING matches -ExpectRunNodeSha / -ExpectAgentPid / -ExpectManagerPid:
#                    Stop-ScheduledTask Node -> the recorded cmd.exe gone (<= 30 s) -> the recorded agent gone (<= 30 s; if it
#                    outlived its cmd.exe it is stopped by its EXACT verified PID) -> Start-ScheduledTask Node -> a NEW agent
#                    (<= 60 s) -> the agent's 127.0.0.1:9600 answers (<= 90 s); then manager PID/start, other task states and
#                    the manager's VM id set are compared with before. The whole run is bounded (-BoundSec, default 240).
param([ValidateSet('identify','restart')][string]$Mode = 'identify', [string]$ExpectRunNodeSha = '', [int]$ExpectAgentPid = 0,
      [int]$ExpectManagerPid = 0, [int]$BoundSec = 240)
$ErrorActionPreference = 'Stop'
$PD = 'C:\ProgramData\Enclave'; $RUN = Join-Path $PD 'run-node.cmd'; $T0 = Get-Date
function Left { $BoundSec - ((Get-Date) - $T0).TotalSeconds }
function Done($o) { $o.mode = $Mode; $o.seconds = [math]::Round(((Get-Date) - $T0).TotalSeconds, 1); $o | ConvertTo-Json -Compress -Depth 4; exit 0 }
function Sha($p) { if (Test-Path -LiteralPath $p) { (Get-FileHash -Algorithm SHA256 -LiteralPath $p).Hash.ToLower() } else { 'absent' } }
function Procs {
  $cm = @(Get-CimInstance Win32_Process -Filter "Name='cmd.exe'" -OperationTimeoutSec 20 | Where-Object { [string]$_.CommandLine -like '*\Enclave\run-node.cmd*' })
  $nd = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -OperationTimeoutSec 20 | Where-Object { [string]$_.CommandLine -like '*\control\windows\node\agent.mjs*' })
  [ordered]@{ cmd = @($cm | ForEach-Object { [ordered]@{ pid = [int]$_.ProcessId; start = $_.CreationDate.ToUniversalTime().ToString('o') } })
              agent = @($nd | ForEach-Object { [ordered]@{ pid = [int]$_.ProcessId; parent = [int]$_.ParentProcessId; start = $_.CreationDate.ToUniversalTime().ToString('o') } }) } }
function Manager {
  $c = @(Get-NetTCPConnection -LocalPort 8091 -State Listen -ErrorAction SilentlyContinue)
  if ($c.Count -ne 1) { return [ordered]@{ pid = 0; start = ''; listeners = $c.Count } }
  $p = Get-CimInstance Win32_Process -Filter "ProcessId=$($c[0].OwningProcess)" -OperationTimeoutSec 20
  [ordered]@{ pid = [int]$p.ProcessId; start = $p.CreationDate.ToUniversalTime().ToString('o'); listeners = 1 } }
function Tasks { @(Get-ScheduledTask -TaskPath '\Enclave\' | Where-Object { $_.TaskName -ne 'Node' } | ForEach-Object { "$($_.TaskName)=$([string]$_.State)" }) -join ',' }
function Vms { try { @((Invoke-RestMethod -UseBasicParsing -TimeoutSec 15 -Uri 'http://127.0.0.1:8091/vms').vms | ForEach-Object { [string]$_.id } | Sort-Object) -join ',' } catch { 'unavailable' } }
function AgentUp { try { (Invoke-WebRequest -UseBasicParsing -TimeoutSec 5 -Uri 'http://127.0.0.1:9600/v1/deployments').StatusCode -eq 200 } catch { $false } }

$t = Get-ScheduledTask -TaskPath '\Enclave\' -TaskName 'Node'; $a = $t.Actions[0]
$o = [ordered]@{ taskState = [string]$t.State; actionExact = ([string]$a.Execute -eq 'cmd.exe' -and [string]$a.Arguments -eq ('/c "' + $RUN + '"') -and $t.Actions.Count -eq 1)
                 runNodeSha = (Sha $RUN); before = (Procs); manager = (Manager) }
if ($Mode -eq 'identify') { $o.otherTasks = (Tasks); $o.vmIds = ((Vms) -split ',').Count; $o.decision = 'identified'; Done $o }

# restart: every identity must match the preflight exactly
$b = $o.before
$why = @()
if (-not $o.actionExact) { $why += 'the Node task action is not exactly cmd.exe /c run-node.cmd' }
if ($o.runNodeSha -ne $ExpectRunNodeSha) { $why += 'run-node.cmd is not the pinned file' }
if ($b.cmd.Count -ne 1 -or $b.agent.Count -ne 1) { $why += "expected one run-node cmd and one agent, found $($b.cmd.Count)/$($b.agent.Count)" }
elseif ($b.agent[0].pid -ne $ExpectAgentPid -or $b.agent[0].parent -ne $b.cmd[0].pid) { $why += 'the agent PID or its parent is not the preflight one' }
if ($o.manager.pid -ne $ExpectManagerPid) { $why += 'the manager PID is not the preflight one' }
if ($why.Count) { $o.decision = 'refused: ' + ($why -join '; '); Done $o }
$tasks0 = Tasks; $vms0 = Vms; $cmdPid = $b.cmd[0].pid; $agentPid = $b.agent[0].pid
$o.stoppedAt = (Get-Date).ToUniversalTime().ToString('o')
Stop-ScheduledTask -TaskPath '\Enclave\' -TaskName 'Node'
$d = (Get-Date).AddSeconds([math]::Min(30, (Left)))
while ((Get-Process -Id $cmdPid -ErrorAction SilentlyContinue) -and (Get-Date) -lt $d) { Start-Sleep -Milliseconds 500 }
if (Get-Process -Id $cmdPid -ErrorAction SilentlyContinue) { $o.decision = 'FAILED: the run-node cmd.exe did not stop; nothing started'; Done $o }
$d = (Get-Date).AddSeconds([math]::Min(30, (Left)))
while ((Get-Process -Id $agentPid -ErrorAction SilentlyContinue) -and (Get-Date) -lt $d) { Start-Sleep -Milliseconds 500 }
$p = Get-CimInstance Win32_Process -Filter "ProcessId=$agentPid" -OperationTimeoutSec 20
if ($p) {
  # it outlived its cmd.exe: stop it ONLY if it is still exactly the recorded agent (same PID, same parent, agent.mjs)
  if ([int]$p.ParentProcessId -eq $cmdPid -and [string]$p.CommandLine -like '*\control\windows\node\agent.mjs*') { Stop-Process -Id $agentPid -Force; $o.agentStoppedByPid = $true }
  Start-Sleep -Seconds 3
  if (Get-Process -Id $agentPid -ErrorAction SilentlyContinue) { $o.decision = 'FAILED: the old agent is still running; nothing started (run-node is stopped: root decides)'; Done $o }
}
Start-ScheduledTask -TaskPath '\Enclave\' -TaskName 'Node'
$o.startedAt = (Get-Date).ToUniversalTime().ToString('o')
$d = (Get-Date).AddSeconds([math]::Min(60, (Left))); $n = $null
while (-not $n -and (Get-Date) -lt $d) { $q = Procs; $n = @($q.agent | Where-Object { $_.pid -ne $agentPid }) | Select-Object -First 1; if (-not $n) { Start-Sleep -Milliseconds 500 } }
if (-not $n) { $o.decision = 'FAILED: no new agent within 60 s (the task was started)'; Done $o }
$d = (Get-Date).AddSeconds([math]::Min(90, (Left))); $up = $false
while (-not $up -and (Get-Date) -lt $d) { $up = AgentUp; if (-not $up) { Start-Sleep -Seconds 1 } }
$o.agentUpAt = $(if ($up) { (Get-Date).ToUniversalTime().ToString('o') } else { $null })
$o.ingressPauseSec = $(if ($up) { [math]::Round(([datetime]$o.agentUpAt - [datetime]$o.stoppedAt).TotalSeconds, 1) } else { $null })
$o.after = (Procs); $m1 = Manager
$o.managerUnchanged = ($m1.pid -eq $o.manager.pid -and $m1.start -eq $o.manager.start)
$o.otherTasksUnchanged = ((Tasks) -eq $tasks0); $o.vmSetUnchanged = ((Vms) -eq $vms0)
$o.decision = $(if ($up -and $o.managerUnchanged -and $o.otherTasksUnchanged -and $o.vmSetUnchanged) { 'restarted: node agent only' } else { 'restarted, CHECK: see the booleans' }); Done $o
