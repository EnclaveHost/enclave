# pair-mock.ps1 - run helper/node-pair-observe.ps1 UNCHANGED against a simulated minipc on Linux pwsh 7 (tests only; adapted
# from the rpc-integrated cutover-mock.ps1 db913924: processes, tasks, listeners, Get-VM, REST to manager/node, simulated clock).
# The two module swaps are REAL: the pinned bundle-swap.ps1 bytes run in real child pwsh processes on real files in the scratch
# root (with tools/swap-prelude.ps1 for the Windows ACL cmdlets and the injected swap faults). Scenarios (by name) change the
# world at the moment the node stops or starts. Copied from node-restart-final (656d's mock) and changed ONLY in the readiness
# a started node publishes (a pass in flight with per-row progress, as host.mjs 4bebf7db), the 9600 'listener-lost' fault and
# 'lease-shrinks-after-start' (the host-state lease reads now + 60 s once the new node runs). node-bounded-observation adds
# 'late-ready' (after 30 s each host-state read takes 20 s of simulated time; rows turn ready at 50 s) and moves
# 'sweep-midpass' readiness to 60 s.
param([string]$Script, [string]$Root, [string]$ParamsFile, [string]$ParamsSha, [string]$Mode = 'apply', [string]$Scenario = 'ok')
$global:S = @{ clock = [datetime]::new(2026, 10, 22, 22, 30, 0, [DateTimeKind]::Utc); next = 50000; procs = [System.Collections.ArrayList]::new()
  nodeStartedAt = $null; scenario = $Scenario; root = $Root; starts = 0; stops = 0
  runner = '0x2fcef48d6ad6919a6264074592b13855968b9f7be52c463764609a68af41447a'; ids = @(Get-Content (Join-Path $Root 'expected-ids.txt')) }
function global:SimMs { [DateTimeOffset]::new($global:S.clock).ToUnixTimeMilliseconds() }
function global:Proc($name, $cmd, $ppid, $procId = 0, $start = $null) { if (-not $procId) { $procId = $global:S.next++ }
  $o = [pscustomobject]@{ ProcessId = $procId; ParentProcessId = $ppid; Name = $name; CommandLine = $cmd; CreationDate = $(if ($start) { $start } else { $global:S.clock.AddMilliseconds($procId % 997) }); ExecutablePath = 'x' }
  [void]$global:S.procs.Add($o); return $o }
# a later run in the same world continues from the processes the previous run left (procs-state.json)
$sf = Join-Path $Root 'procs-state.json'
$st = Get-Content $(if (Test-Path $sf) { $sf } else { Join-Path $Root 'procs.json' }) | ConvertFrom-Json
$global:S.next = 1 + [int](@($st | ForEach-Object { [int]$_.pid }) + 50000 | Measure-Object -Maximum).Maximum
foreach ($p in $st) { $null = Proc $p.name $p.cmd $p.ppid $p.pid $(if ($p.start -is [datetime]) { $p.start.ToUniversalTime() } else { [datetime]::Parse($p.start).ToUniversalTime() }) }
function global:Get-Date { $global:S.clock }
function global:Start-Sleep { param([int]$Seconds = 0, [int]$Milliseconds = 0) $global:S.clock = $global:S.clock.AddMilliseconds($Seconds * 1000 + $Milliseconds) }
function global:Get-CimInstance { param([Parameter(Position = 0)]$ClassName, $Filter, $OperationTimeoutSec)
  if ($global:S.scenario -eq 'slow-pins' -and -not $global:S.pinDelay) { $global:S.pinDelay = $true; Start-Sleep -Seconds 900 }
  $all = @($global:S.procs)
  if ($Filter -match "^Name='(.+)'$") { $n = $matches[1]; return @($all | Where-Object { $_.Name -eq $n }) }
  if ($Filter -match '^ProcessId=(\d+)$') { $i = [int]$matches[1]; return ($all | Where-Object { $_.ProcessId -eq $i } | Select-Object -First 1) }
  return $all }
function global:Get-NetTCPConnection { param($LocalPort, $State, $ErrorAction)
  $s = $global:S
  if ($LocalPort -eq 9600) {
    # stale-listener: a foreign process still listens once the node is stopped; foreign-9600: another process owns it after the start
    if ($s.scenario -eq 'stale-listener' -and $s.stops -ge 1 -and $s.starts -eq 0) { return @([pscustomobject]@{ OwningProcess = 7777 }) }
    if ($s.scenario -eq 'foreign-9600' -and $s.starts -ge 1) { return @([pscustomobject]@{ OwningProcess = 7778 }) }
    # listener-lost: the new agent owns 9600 for its first 40 s, then nobody does (it stopped listening; the process remains)
    if ($s.scenario -eq 'listener-lost' -and $s.nodeStartedAt -and ($s.clock - $s.nodeStartedAt).TotalSeconds -gt 40) { return @() }
    $p = @($s.procs | Where-Object { $_.CommandLine -like '*node\agent.mjs*' }); return @($p | ForEach-Object { [pscustomobject]@{ OwningProcess = $_.ProcessId } }) }
  @([pscustomobject]@{ OwningProcess = 4001 }) }
function global:Get-VM { param($ErrorAction)
  $v = @(Get-Content (Join-Path $global:S.root 'hyperv.json') | ConvertFrom-Json)
  if ($global:S.scenario -eq 'vm-replaced' -and $global:S.starts -ge 1) { $v[0].Id = 'ffffffff-0000-0000-0000-000000000000' }
  return $v }
function global:Get-ScheduledTask { param($TaskPath, $TaskName, $ErrorAction)
  $sc = $global:S.scenario
  $t = foreach ($n in 'Card', 'Network', 'Node', 'Relay', 'Shield') { [pscustomobject]@{ TaskName = $n; State = 'Running'
    Actions = @([pscustomobject]@{ Execute = 'cmd.exe'; Arguments = $(if ($n -eq 'Node' -and $sc -eq 'task-action-changed') { '/c "C:\Temp\other.cmd"' } else { "/c `"C:\ProgramData\Enclave\run-$($n.ToLower()).cmd`"" }) }) } }
  if ($TaskName -eq 'Update') { $global:S.updReads = 1 + [int]$global:S.updReads }
  $ust = $(switch ($sc) { 'update-running' { 'Running' } 'update-queued-before-stop' { if ([int]$global:S.updReads -ge 2) { 'Queued' } else { 'Ready' } } default { 'Ready' } })
  $t = @($t) + [pscustomobject]@{ TaskName = 'Update'; State = $ust; Settings = [pscustomobject]@{ Enabled = $true }
    Actions = @([pscustomobject]@{ Execute = 'powershell.exe'; Arguments = '-NoProfile -File "C:\Program Files\Enclave\update-host.ps1"' }) }
  if ($TaskName) { $t | Where-Object { $_.TaskName -eq $TaskName } } else { $t } }
function global:Get-ScheduledTaskInfo { param($InputObject, $ErrorAction)
  # the next updater run: 60 min away normally; 'update-in-reserve' = after this run's bound but inside the reserved return
  $m = $(switch ($global:S.scenario) { 'update-due' { 5 } 'update-in-reserve' { 25 } default { 60 } })
  [pscustomobject]@{ NextRunTime = $global:S.clock.AddMinutes($m) } }
function global:Arm($name, $value) { Get-ChildItem -LiteralPath $global:S.root -Filter 'swap-count-*' | Remove-Item; $f = Join-Path $global:S.root 'swap-fault.json'; $o = @{}; if (Test-Path $f) { $j = Get-Content -Raw $f | ConvertFrom-Json; foreach ($k in $j.PSObject.Properties) { $o[$k.Name] = $k.Value } }
  $o[$name] = $value; $o | ConvertTo-Json | Set-Content $f }
function global:Stop-ScheduledTask { param($TaskPath, $TaskName)
  if ($TaskName -ne 'Node') { throw "mock: only Node may be stopped, not $TaskName" }
  $s = $global:S; $s.stops++; $survive = ($s.scenario -eq 'agent-unkillable')
  foreach ($c in @($s.procs | Where-Object { $_.Name -eq 'cmd.exe' -and $_.CommandLine -like '*run-node.cmd*' })) { $s.procs.Remove($c)
    if (-not $survive) { foreach ($a in @($s.procs | Where-Object { $_.ParentProcessId -eq $c.ProcessId })) { $s.procs.Remove($a) } } }
  if (-not $survive) { $s.nodeStartedAt = $null }
  Add-Content (Join-Path $s.root 'node-events.txt') ('stop ' + $s.clock.ToString('o'))
  # faults that happen WHILE the node is stopped (between the proven stop and the swaps)
  $stg = Join-Path $s.root 'stage'
  switch ($s.scenario) {
    'host-staged-changed' { [IO.File]::AppendAllText((Join-Path $stg 'new/host.mjs'), "`n// changed after the pins`n") }
    'host-staged-changed-undo-hangs' { [IO.File]::AppendAllText((Join-Path $stg 'new/host.mjs'), "`n// changed`n"); Arm 'chain.mjs' 'hang-on-2' }
    'chain-crash' { Arm 'chain.mjs' 'crash' }
    'host-hang' { Arm 'host.mjs' 'hang' }
    'chain-acl-mismatch' { Arm 'chain.mjs' 'acl-mismatch' }
    'host-crash-after-replace' { Arm 'host.mjs' 'crash-after-replace' }
    'rollback-chain-backup-gone' { Remove-Item -LiteralPath (Join-Path $stg ('swap-chain/.bundle-swap/backup-' + ([string](Get-Content (Join-Path $s.root 'chain-old.sha'))).Substring(0, 12) + '.mjs')) }
    'module-changed-while-stopped' { [IO.File]::AppendAllText((Join-Path $s.root 'control/windows/node/chain.mjs'), "`n// operator`n") }
    'config-changed-while-stopped' { [IO.File]::AppendAllText((Join-Path $s.root 'run-node.cmd'), "rem operator`r`n") }
    'throw-after-task-stop' { throw 'mock: the stop completed but the task response failed' } } }
function global:Start-ScheduledTask { param($TaskPath, $TaskName)
  if ($TaskName -ne 'Node') { throw "mock: only Node may be started" }
  $s = $global:S; $ppid = $(if ($s.scenario -eq 'foreign-parent') { 999 } else { 3292 })
  $c = Proc 'cmd.exe' 'cmd.exe /c "C:\ProgramData\Enclave\run-node.cmd"' $ppid
  # pid-reuse: the new agent gets the OLD agent's PID (a new process: another start time) - a new identity, accepted
  $agentPid = $(if ($s.scenario -eq 'pid-reuse') { 8644 } else { 0 })
  $null = Proc 'node.exe' '"C:\Program Files\Enclave\runtime\node\node.exe" "C:\Program Files\Enclave\control\windows\node\agent.mjs"' $c.ProcessId $agentPid $s.clock.AddMilliseconds(250)
  $s.nodeStartedAt = $s.clock; $s.starts++
  Add-Content (Join-Path $s.root 'node-events.txt') ('start ' + $s.clock.ToString('o'))
  if ($s.scenario -eq 'other-task-changed') { $null = Proc 'cmd.exe' 'cmd.exe /c "C:\ProgramData\Enclave\run-relay.cmd"' 1 }
  if ($s.scenario -eq 'throw-after-task-start') { throw 'mock: the start completed but the task response failed' } }
function global:Stop-Process { param($Id, [switch]$Force)
  $s = $global:S; $p = $s.procs | Where-Object { $_.ProcessId -eq $Id } | Select-Object -First 1
  Add-Content (Join-Path $s.root 'node-events.txt') ("kill $Id")
  if (-not $p) { return }
  if ($p.CommandLine -like '*node\agent.mjs*' -and $s.scenario -eq 'agent-unkillable') { return }
  $s.procs.Remove($p) }
function global:Invoke-RestMethod { param($Uri, [switch]$UseBasicParsing, $TimeoutSec)
  $s = $global:S
  if ($Uri -like '*8091/vms') { return [pscustomobject]@{ vms = @(Get-Content (Join-Path $s.root 'vms.json') | ConvertFrom-Json) } }
  if ($Uri -like '*9600/v1/host/state') {
    if (-not @($s.procs | Where-Object { $_.CommandLine -like '*node\agent.mjs*' }).Count) { throw 'mock: refused' }
    $s.leaseReads = 1 + [int]$s.leaseReads
    if ($s.scenario -eq 'lease-shrinks-before-stop' -and $s.leaseReads -gt 1) {
      return [pscustomobject]@{ deployments = @($s.ids | ForEach-Object { [pscustomobject]@{ id = $_; status = 'running'; leaseUntil = [DateTimeOffset]::new($s.clock).ToUnixTimeSeconds() + 30 } }) } }
    $records = @(Get-Content -Raw (Join-Path $s.root 'leases.json') | ConvertFrom-Json)
    if ($s.scenario -eq 'lease-shrinks-after-start' -and $s.nodeStartedAt) { foreach ($x in $records) { $x.leaseUntil = [DateTimeOffset]::new($s.clock).ToUnixTimeSeconds() + 60 } }
    # the running set changes between the pins (read 1) and the read immediately before the stop (read 2)
    if ($s.leaseReads -gt 1 -and $s.scenario -eq 'running-added-before-stop') { $records += [pscustomobject]@{ id = '0x' + ('c' * 64); status = 'running'; leaseUntil = $records[0].leaseUntil } }
    if ($s.leaseReads -gt 1 -and $s.scenario -eq 'running-removed-before-stop') { $records[1].status = 'stopped' }
    $ready = $null
    # a started node: ONE pass (sequence 1) started 1 s after the start; every row 'pending' for its first 20 s, then 'ready'
    # unless the scenario says otherwise. The pass completes at 30 s, except in the scenarios whose sweep never completes
    # here (the slow failing claim sweep: rows are published while the pass is still in flight).
    if ($s.nodeStartedAt) {
      $age = ($s.clock - $s.nodeStartedAt).TotalSeconds; $ms = SimMs; $sc = $s.scenario
      $started = [DateTimeOffset]::new($s.nodeStartedAt).ToUnixTimeMilliseconds() + 1000
      if ($sc -eq 'stale-readiness') { $started = [DateTimeOffset]::new($s.nodeStartedAt).ToUnixTimeMilliseconds() - 60000 }
      $inflight = ($age -lt 30) -or ($sc -in 'late-ready', 'sweep-midpass', 'row-pending', 'row-not-ready', 'row-old-sequence', 'row-lease-mismatch', 'row-other-runner', 'listener-lost')
      $rows = @($records | ForEach-Object { $i = [string]$_.id; $st = 'ready'; $seq = 1; $lu = $_.leaseUntil; $rn = $s.runner
        if ($age -lt 20) { $st = 'pending' }
        switch ($sc) {
          'sweep-midpass' { if ($i -eq $s.ids[1] -and $age -lt 60) { $st = 'pending' } }
          'late-ready' { if ($age -lt 50) { $st = 'pending' } }
          'row-pending' { if ($i -eq $s.ids[1]) { $st = 'pending' } }
          'listener-lost' { if ($i -eq $s.ids[1]) { $st = 'pending' } }
          'row-not-ready' { if ($i -eq $s.ids[0]) { $st = 'not-ready' } }
          'row-old-sequence' { if ($i -eq $s.ids[0]) { $seq = 0 } }
          'row-lease-mismatch' { if ($i -eq $s.ids[0]) { $lu = $lu + 1 } }
          'row-other-runner' { if ($i -eq $s.ids[0]) { $rn = '0x' + ('9' * 64) } } }
        if ($st -eq 'pending') { [pscustomobject]@{ id = $i; sequence = $seq; status = 'pending' } }
        else { [pscustomobject]@{ id = $i; sequence = $seq; status = $st; observedAt = $ms; checkedAt = $ms; leaseUntil = $lu; runner = $rn } } })
      if ($sc -ne 'no-pass-loop') { $ready = [pscustomobject]@{ sequence = 1; startedAt = $started; completedAt = $(if ($inflight) { 0 } else { $ms }); inFlight = $inflight; deployments = $rows } } }
    if ($s.scenario -eq 'late-ready' -and $s.nodeStartedAt -and ($s.clock - $s.nodeStartedAt).TotalSeconds -gt 30) { $s.clock = $s.clock.AddSeconds(20) }   # the read 'took' 20 s
    return [pscustomobject]@{ deployments = $records; leaseReadiness = $ready } }
  throw "mock: no $Uri" }
$env:PAIR_MOCK_ROOT = $Root
& $Script -Mode $Mode -ParamsFile $ParamsFile -ParamsSha $ParamsSha
$rc = $LASTEXITCODE
@($global:S.procs | ForEach-Object { @{ pid = $_.ProcessId; ppid = $_.ParentProcessId; name = $_.Name; cmd = $_.CommandLine; start = $_.CreationDate.ToUniversalTime().ToString('o') } }) | ConvertTo-Json -Depth 3 | Set-Content $sf
exit $rc
