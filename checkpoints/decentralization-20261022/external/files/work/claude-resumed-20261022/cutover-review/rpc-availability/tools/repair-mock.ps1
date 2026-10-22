# repair-mock.ps1 - run a (path-transformed) run-node-rpc-repair.ps1 against SIMULATED Windows cmdlets on Linux pwsh (tests only).
param([string]$Script, [string]$Root, [string]$Scenario = 'ok', [string]$Mode = 'repair', [string]$OldSha, [string]$NewSha)
$global:S = @{ sc = $Scenario; root = $Root; clock = [datetime]::new(2026,10,22,3,0,0,[DateTimeKind]::Utc); next = 300; stopped = $false; cimFailed = $false
  procs = [Collections.ArrayList]::new(); starts = 0 }
function global:P($procId, $ppid, $name, $cmd) { [void]$global:S.procs.Add([pscustomobject]@{ ProcessId = $procId; ParentProcessId = $ppid; Name = $name; CommandLine = $cmd; CreationDate = $global:S.clock.AddSeconds(-$procId) }) }
$RUN = Join-Path $Root 'run-node.cmd'; $global:S.run = $RUN
P 100 1 'cmd.exe' 'cmd.exe /c "C:\ProgramData\Enclave\run-node.cmd"'; P 101 100 'node.exe' '"node.exe" "C:\Program Files\Enclave\control\windows\node\agent.mjs"'; P 200 1 'node.exe' 'manager main.mjs'
function global:Get-Date { $global:S.clock }
function global:Start-Sleep { param([int]$Seconds = 0, [int]$Milliseconds = 0) $global:S.clock = $global:S.clock.AddMilliseconds($Seconds * 1000 + $Milliseconds) }
function global:Get-CimInstance { param([Parameter(Position = 0)]$ClassName, $Filter, $OperationTimeoutSec)
  $s = $global:S
  if ($s.stopped -and -not $s.cimFailed -and $s.sc -like 'cim-fails-after-stop*') { $s.cimFailed = $true; throw 'mock: CIM query failed after the stop' }
  $all = @($s.procs)
  if ($Filter -match "^Name='(.+)'$") { return @($all | Where-Object { $_.Name -eq $matches[1] }) }
  if ($Filter -match '^ProcessId=(\d+)$') { return ($all | Where-Object { $_.ProcessId -eq [int]$matches[1] } | Select-Object -First 1) }
  return $all }
function global:Get-NetTCPConnection { param($LocalPort, $State, $ErrorAction) @([pscustomobject]@{ OwningProcess = 200 }) }
function global:Get-ScheduledTask { param($TaskPath, $TaskName, $ErrorAction)
  $t = @([pscustomobject]@{ TaskName = 'Node'; State = 'Running'; Actions = @([pscustomobject]@{ Execute = 'cmd.exe'; Arguments = '/c "' + $global:S.run + '"' }) },
         [pscustomobject]@{ TaskName = 'Network'; State = 'Running'; Actions = @([pscustomobject]@{ Execute = 'cmd.exe'; Arguments = '/c "C:\ProgramData\Enclave\run-network.cmd"' }) },
         [pscustomobject]@{ TaskName = 'Update'; State = 'Ready'; Actions = @([pscustomobject]@{ Execute = 'powershell.exe'; Arguments = '-File "C:\Program Files\Enclave\update-host.ps1"' }) })
  if ($TaskName) { $t | Where-Object { $_.TaskName -eq $TaskName } } else { $t } }
function global:Get-ScheduledTaskInfo { param($InputObject) [pscustomobject]@{ NextRunTime = (Get-Date).AddMinutes($(if ($global:S.sc -eq 'update-due') { 2 } else { 50 })) } }
function global:Stop-ScheduledTask { param($TaskPath, $TaskName) $s = $global:S; $s.stopped = $true; Add-Content (Join-Path $s.root "stops.txt") "stop"
  foreach ($p in @($s.procs | Where-Object { $_.Name -eq 'cmd.exe' -and $_.CommandLine -like '*run-node.cmd*' })) { $s.procs.Remove($p) }
  if ($s.sc -notin 'agent-exits-before-kill', 'cim-fails-after-stop-agent-remains') { foreach ($p in @($s.procs | Where-Object { $_.CommandLine -like '*node\agent.mjs*' })) { $s.procs.Remove($p) } } }
function global:Start-ScheduledTask { param($TaskPath, $TaskName) $s = $global:S; $s.starts++; Add-Content (Join-Path $s.root 'starts.txt') 'start'
  $c = $s.next++; $g = $s.next++; P $c 1 'cmd.exe' 'cmd.exe /c "C:\ProgramData\Enclave\run-node.cmd"'; P $g $c 'node.exe' '"node.exe" "C:\Program Files\Enclave\control\windows\node\agent.mjs"'
  if ($s.sc -eq 'start-throws') { throw 'mock: the start request reply was lost (the task DID start)' } }
function global:Stop-Process { param($Id, [switch]$Force) $s = $global:S
  $p = $s.procs | Where-Object { $_.ProcessId -eq $Id } | Select-Object -First 1; if ($p) { $s.procs.Remove($p) }
  if ($s.sc -eq 'agent-exits-before-kill') { throw "mock: Cannot find a process with the process identifier $Id." } }
function global:Invoke-RestMethod { param($Uri, [switch]$UseBasicParsing, $TimeoutSec)
  if ($Uri -like '*8091/vms') { return [pscustomobject]@{ vms = @([pscustomobject]@{ id = 'hv1' }, [pscustomobject]@{ id = 'hv2' }) } }
  if ($Uri -like '*9600/v1/host/state') {
    if ($global:S.sc -eq 'lease-unreadable') { throw 'mock: refused' }
    $now = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds(); $min = $(if ($global:S.sc -eq 'lease-short') { 250 } else { 900 })
    return [pscustomobject]@{ deployments = @([pscustomobject]@{ id = 'a'; status = 'running'; leaseUntil = $now + $min }, [pscustomobject]@{ id = 'b'; status = 'running'; leaseUntil = $now + 1500 },
                                              [pscustomobject]@{ id = 'h'; status = 'held'; leaseUntil = $now + 30 }) } }
  throw "mock: no $Uri" }
function global:Invoke-WebRequest { param($Uri, [switch]$UseBasicParsing, $TimeoutSec)
  if (@($global:S.procs | Where-Object { $_.CommandLine -like '*node\agent.mjs*' }).Count) { return [pscustomobject]@{ StatusCode = 200 } }; throw 'mock: refused' }
function global:Get-Acl { param($LiteralPath) $a = [pscustomobject]@{ sddl = 'D:PAI(A;;FA;;;SY)(A;;FA;;;BA)' }
  $a | Add-Member ScriptMethod GetSecurityDescriptorSddlForm { param($x) $this.sddl }; $a | Add-Member ScriptMethod SetSecurityDescriptorSddlForm { param($x, $y) $this.sddl = $x }; $a }
function global:Set-Acl { param($LiteralPath, $AclObject) }
$st = @{ cmd = 100; agent = 101 }; $iso = { param($i) $global:S.clock.AddSeconds(-$i).ToUniversalTime().ToString('o') }
& $Script -Mode $Mode -ExpectOldSha $OldSha -ExpectNewSha $NewSha -ExpectCmdPid 100 -ExpectCmdStart (& $iso 100) -ExpectAgentPid 101 -ExpectAgentStart (& $iso 101) -ExpectManagerPid 200 -ExpectManagerStart (& $iso 200)
exit $LASTEXITCODE
