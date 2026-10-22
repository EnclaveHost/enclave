# node-pair-restart.ps1 - the ONE bounded node-only window on minipc (PowerShell 5.1): stop the \Enclave\Node task, replace
# EXACTLY the two pinned node modules (windows\node\chain.mjs, then windows\node\host.mjs) through the reviewed bundle-swap.ps1
# (21d85c69: CAS, staged sha, node --check on the exact bytes, private SY+BA backup, ACL restored, hash-only journal), and start
# the node again, accepted only with a NEW agent proving a completed lease pass on its own 127.0.0.1:9600 listener.
# Prepared by Claude for ROOT; never run by its author. Executed ONLY from hash-verified bytes by root's one-shot SYSTEM task
# loader (the same `& ([scriptblock]::Create(bytes)) -Mode M -ParamsFile P -ParamsSha S` pattern as root-node-hold.py), so an
# SSH disconnect cannot interrupt it. No -File, no ExecutionPolicy change of any scope.
#
# NEVER touches: configs (run-node.cmd, node-config*.cmd, privacy-config.json), the privacy agent / \Enclave\Network, the
# manager / \Enclave\Shield, Relay, Card, Update, any VM, wallet, contract, key or policy. Only the \Enclave\Node task is
# stopped and started, and only the two pinned module paths are written (by bundle-swap.ps1, one child process per file).
#
#  -Mode identify  read-only (bounded): what root needs for the pins (identities, task action, scheduler parent, listener,
#                  manager, privacy agent, VM sets, other tasks, updater, leases, file shas).
#  -Mode apply     old pair -> new pair.   -Mode rollback   new pair -> old pair (root's explicit return; the backups that the
#                  apply's bundle-swap work directories hold).
#   1 pins: both targets == the FROM pair, both staged/backup bytes as pinned, bundle-swap inspect (apply) of each; node cmd +
#     agent == pinned PID+start, cmd's parent == the pinned Task Scheduler process, 9600 owned by the pinned agent; manager,
#     privacy agent, Hyper-V + manager VM sets, other \Enclave\ tasks, unchanged-file shas; updater; lease budget.
#   2 STOP the Node task (fresh updater + lease + file read immediately before; the bounded task request; no automatic retry).
#   3 with the node PROVEN stopped and no 9600 listener left: file 1, then file 2, each by ONE bounded bundle-swap child.
#     A step counts only with the child's exit confirmed AND the coordinator's own read of target sha + swap journal.
#       - both done                      -> the TO pair
#       - a step CONCLUSIVELY unchanged  -> the earlier PROVEN step undone (its inverse bundle-swap), proven -> the FROM pair
#       - anything else (timeout, unconfirmed child, other bytes, journal left started, an undo not proven) -> UNKNOWN:
#         nothing else is written, the node is NOT started, the actual state is journaled (RECOVERY_REQUIRED)
#   4 START the node only on a CONSISTENT pair (re-read: both TO or both FROM); a new agent (new PID+start, child of a new
#     run-node cmd.exe whose parent is the pinned Task Scheduler process) must own 9600 before AND after a readiness read
#     showing a completed (not in-flight) lease pass started after that agent, every expected id ready + running + leased.
#   5 POST: manager, privacy agent, scheduler, Hyper-V + manager VM sets, other tasks, unchanged files; node.log counts.
# Every step appends ONE JSON line to <Stage>\pair-<RunId>.jsonl (hashes, PIDs, times, counts, decisions; never file content).
#
# BOUNDS (honest): every child query (<= 15 s), task request (<= 20 s) and swap child (<= 30 s) is capped by its own limit AND
# by the global -BoundSec remainder (Lim); the forward path is also capped by the lease deadline minus root's reserved rollback.
# Local file hashing and journal appends are not individually bounded. A task request or swap child whose outcome is not
# confirmed is never retried and never compensated: it ends the run as RECOVERY_REQUIRED with what could still be read.
param([ValidateSet('identify','apply','rollback')][string]$Mode = 'identify', [Parameter(Mandatory=$true)][string]$ParamsFile, [Parameter(Mandatory=$true)][string]$ParamsSha)
# N2: the trap is scope-wide; it must already see phase 'pins' (nothing changed)
$phase = 'pins'; $LeaseEnd = $null; $Fwd = $false
$ErrorActionPreference = 'Stop'; $ProgressPreference = 'SilentlyContinue'; $T0 = Get-Date
$pb = [IO.File]::ReadAllBytes($ParamsFile)          # ONE read: hashed, then parsed from the same bytes
if ((-join ([Security.Cryptography.SHA256]::Create().ComputeHash($pb) | ForEach-Object { $_.ToString('x2') })) -ne $ParamsSha) { exit 4 }
$PRM = [Text.Encoding]::UTF8.GetString($pb) | ConvertFrom-Json
$Stage = [string]$PRM.stage; $Run = [string]$PRM.runId; $BoundSec = [int]$PRM.boundSec
# testRoot / testPrelude: ONLY the mock harness sets them (inside the sha-pinned params); they can never run on Windows
$TR = [string]$PRM.testRoot
if ($TR -and $env:OS -eq 'Windows_NT') { exit 5 }
$PD = $(if ($TR) { $TR } else { 'C:\ProgramData\Enclave' }); $NODELOG = Join-Path (Join-Path $PD 'logs') 'node.log'
$NODEDIR = $(if ($TR) { Join-Path $TR 'control\windows\node' } else { 'C:\Program Files\Enclave\control\windows\node' })
$AGENT_PAT = '*\control\windows\node\agent.mjs*'; $RUN_PAT = '*\Enclave\run-node.cmd*'
$J = Join-Path $Stage ("pair-$Run.jsonl")
# the ONLY targets this script can write, in apply order (the callee module first); rollback runs them in reverse
$PAIR = @('chain.mjs', 'host.mjs')
# worst cases (s) of the bounded phases after the pins, from the per-call caps:
#   stop: snapshot 15 + BeforeStop (updater 10 + lease 10) + task 20 + cmd gone 30 + agent gone 30 + identity 15 + kill wait 10
#         + empty snapshot 15 = 155, + the 9600 listener read 15                                        -> STOP_WORST 170
#         of which AFTER the lease deadline is read (BeforeStop's host-state read fixes LeaseEnd): task 20 + 30 + 30 + 15
#         + 10 + 15 + listener 15                                                                       -> STOP_AFTER_LEASE 135
#   swap: 2 steps x (child 30 + reads) + 1 proven undo x (child 30 + reads)                            -> SWAP_WORST 100
#   post: Hyper-V 15 + manager VMs 10 + manager 30 + others 15 + privacy 15 + scheduler 15 + update 10 -> POST_WORST 120
# readiness: a completed first lease/adoption pass was MEASURED at 6m47s-7m56s on minipc (isolation adopted, 429-limited RPC):
# lease.startNodeSec below MIN_START_NODE (476 s measured, rounded up) is refused, never silently accepted
$STOP_WORST = 170; $STOP_AFTER_LEASE = 135; $SWAP_WORST = 100; $POST_WORST = 120; $MAX_BOUND = 1140; $MIN_START_NODE = 480   # task limit 20 min

# ---------------------------------------------------------------- verbatim from node-hold-cutover.ps1 df2e58f2 (root-reviewed)
# verbatim df2e58f2 L74-74
function Iso($v) { if ($v -is [datetime]) { $v.ToUniversalTime().ToString('o') } else { [string]$v } }
# verbatim df2e58f2 L75-75
function Left { $BoundSec - ((Get-Date) - $T0).TotalSeconds }
# verbatim df2e58f2 L84-84
function NowS { [DateTimeOffset]::new((Get-Date).ToUniversalTime()).ToUnixTimeSeconds() }
# verbatim df2e58f2 L85-85
function LeaseLeft { if ($null -eq $LeaseEnd) { return 0 }; $LeaseEnd - (NowS) - [int]$PRM.lease.marginSec - [int]$PRM.lease.revertSec }
# MODIFIED (no revert inside this run): the forward path keeps the post-check time of the global bound, and LeaseLeft already
# reserves root's rollback (lease.revertSec) before the first lease ends
function ForwardLeft { [math]::Min(((Left) - $POST_WORST), (LeaseLeft)) }
# verbatim df2e58f2 L87-87
function Lim($limitSec) { $l = [math]::Min($limitSec, (Left)); if ($Fwd) { $l = [math]::Min($l, (ForwardLeft)) }; return [math]::Max(0, $l) }
# verbatim df2e58f2 L88-88
function NeedForward { if ($Fwd -and (ForwardLeft) -le 0) { throw 'forward deadline reached; reserved recovery time must not be consumed' } }
# verbatim df2e58f2 L94-105
function UpdateDecision($v) {
  if ($null -eq $v -or $v -is [string]) { return 'the \Enclave\Update task is absent or unreadable' }
  $st = [string]$v.state; $en = $v.enabled; $nx = $v.next
  if ($st -in 'Running', 'Queued') { return "the \Enclave\Update task runs or is due inside this window (state $st)" }
  if (-not ($en -is [bool])) { return 'the \Enclave\Update task Enabled flag is not a boolean' }
  if ($st -eq 'Disabled') { if ($en -eq $false -and ($null -eq $nx -or [string]$nx -eq '')) { return $null }; return 'the \Enclave\Update task is Disabled but enabled or with a next run (incoherent)' }
  if ($st -ne 'Ready' -or $en -ne $true) { return "the \Enclave\Update task state $st / enabled $en is not accepted (only Ready+enabled or Disabled)" }
  if ($null -eq $nx -or [string]$nx -eq '') { return 'the \Enclave\Update task has no known next run' }
  $t = $null; try { $t = [DateTimeOffset]::Parse((Iso $nx)).UtcDateTime } catch {}
  if ($null -eq $t) { return 'the \Enclave\Update next run time is unparseable' }
  if ($t -lt (Get-Date).ToUniversalTime().AddSeconds($BoundSec + 60)) { return 'the \Enclave\Update task runs or is due inside this window' }
  return $null }
# verbatim df2e58f2 L107-111
function UpdateState([double]$limitSec = 10) {
  if ($TR) { $t = Get-ScheduledTask -TaskPath '\Enclave\' -TaskName 'Update' -ErrorAction Stop; $i = Get-ScheduledTaskInfo -InputObject $t
    return [ordered]@{ state = [string]$t.State; enabled = $t.Settings.Enabled; next = $(if ($i.NextRunTime -is [datetime]) { $i.NextRunTime.ToUniversalTime().ToString('o') } else { $null }) } }
  @(Query { $t = Get-ScheduledTask -TaskPath '\Enclave\' -TaskName 'Update' -ErrorAction Stop; $i = Get-ScheduledTaskInfo -InputObject $t -ErrorAction Stop
    [ordered]@{ state = [string]$t.State; enabled = $t.Settings.Enabled; next = $(if ($i.NextRunTime -is [datetime]) { $i.NextRunTime.ToUniversalTime().ToString('o') } else { $null }) } } $limitSec)[0] }
# verbatim df2e58f2 L134-134
function Now { (Get-Date).ToUniversalTime().ToString('o') }
# verbatim df2e58f2 L135-135
function NowMs { [DateTimeOffset]::new((Get-Date).ToUniversalTime()).ToUnixTimeMilliseconds() }
# verbatim df2e58f2 L136-136
function IsoMs($s) { [DateTimeOffset]::Parse((Iso $s)).ToUnixTimeMilliseconds() }
# verbatim df2e58f2 L149-149
function Sha($p) { if (Test-Path -LiteralPath $p) { (Get-FileHash -Algorithm SHA256 -LiteralPath $p).Hash.ToLower() } else { 'absent' } }
# verbatim df2e58f2 L150-151
function Log($o) { $o.at = (Now); $o.sec = [math]::Round(((Get-Date) - $T0).TotalSeconds, 1)
  [IO.File]::AppendAllText($J, (($o | ConvertTo-Json -Compress -Depth 6) + "`n")) }
# verbatim df2e58f2 L152-152
function Final($decision, $o) { $o.final = $decision; Log $o; exit 0 }
# verbatim df2e58f2 L156-193
function Invoke-BoundedQuery([scriptblock]$Query, [int]$BudgetMs = 15000) {
  if ($BudgetMs -lt 2500 -or $BudgetMs -gt 30000) { throw 'query budget must include 2000 ms for cleanup' }
  $sw = [Diagnostics.Stopwatch]::StartNew()
  $body = '$ErrorActionPreference="Stop";$ProgressPreference="SilentlyContinue";try{$v=& {' + $Query.ToString() + '};[Console]::Out.Write((ConvertTo-Json -InputObject @($v) -Depth 8 -Compress))}catch{exit 2}'
  $si = New-Object Diagnostics.ProcessStartInfo
  $si.FileName = Join-Path $PSHOME $(if ($env:OS -eq 'Windows_NT') { 'powershell.exe' } else { 'pwsh' })
  $si.Arguments = '-NoProfile -NonInteractive -EncodedCommand ' + [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($body))
  $si.UseShellExecute = $false; $si.CreateNoWindow = $true
  $si.RedirectStandardOutput = $true; $si.RedirectStandardError = $true
  $p = New-Object Diagnostics.Process; $p.StartInfo = $si
  $started = $false; $timedOut = $false; $reason = $null; $value = $null; $exited = $false
  try {
    $started = $p.Start()
    if (-not $started) { throw 'query process failed to start' }
    $stdout = $p.StandardOutput.ReadToEndAsync(); $stderr = $p.StandardError.ReadToEndAsync()
    $left = [math]::Max(0, $BudgetMs - 2000 - $sw.ElapsedMilliseconds)
    $exited = $p.WaitForExit([int]$left)
    if (-not $exited) { $timedOut = $true; $reason = 'query deadline reached' }
    elseif ($p.ExitCode -ne 0) { $reason = 'query process failed' }
    else {
      $left = [math]::Max(0, $BudgetMs - 2000 - $sw.ElapsedMilliseconds)
      if (-not $stdout.Wait([int]$left)) { $timedOut = $true; $reason = 'query output deadline reached' }
      else { $value = ConvertFrom-Json -InputObject $stdout.Result }
    }
  } catch { $reason = 'query invocation failed' }
  finally {
    if ($started -and -not $p.HasExited) {
      try { $p.Kill() } catch {}
      $left = [math]::Max(0, $BudgetMs - $sw.ElapsedMilliseconds)
      $exited = $p.WaitForExit([int]$left)
    } elseif ($started) { $exited = $true }
    if ($started -and -not $exited) { $reason = 'query child exit unconfirmed' }
    $childId = $(if ($started) { $p.Id } else { $null }); $p.Dispose()
  }
  if ($sw.ElapsedMilliseconds -gt $BudgetMs) { $timedOut = $true; $reason = 'query exceeded total budget' }
  [pscustomobject]@{ ok = ($null -eq $reason -and $exited); value = $(if ($null -eq $reason) { $value } else { $null })
    reason = $reason; timedOut = $timedOut; childExited = $exited; childId = $childId; elapsedMs = $sw.ElapsedMilliseconds }
}
# verbatim df2e58f2 L196-204
function Query([scriptblock]$body, [double]$limitSec = 15) {
  if ($script:QueryCleanupFailed) { throw 'previous query child exit unconfirmed; no further reader will be launched' }
  $ms = [int][math]::Floor(1000 * (Lim ([math]::Min(15, $limitSec))))
  if ($ms -lt 2500) { throw 'not enough time for a query and confirmed child cleanup' }
  $r = Invoke-BoundedQuery $body $ms
  if (-not $r.childExited) { $script:QueryCleanupFailed = $true }
  if (-not $r.ok) { throw ('read-only native query failed: ' + $r.reason) }
  $r.value
}
# verbatim df2e58f2 L207-207
function PollRoom($lim) { (Lim (($lim - (Get-Date)).TotalSeconds)) -ge 2.5 }
# verbatim df2e58f2 L208-208
function Utc($p) { if ($p.CreationDate -is [datetime]) { $p.CreationDate.ToUniversalTime().ToString('o') } else { Iso $p.CreationDate } }
# verbatim df2e58f2 L209-213
function ProcessRows([string]$filter, [double]$limitSec = 15) {
  $quoted = "'" + $filter.Replace("'", "''") + "'"
  $code = 'Get-CimInstance Win32_Process -Filter ' + $quoted + ' -OperationTimeoutSec 5 | ForEach-Object { [ordered]@{ProcessId=[int]$_.ProcessId;ParentProcessId=[int]$_.ParentProcessId;Name=[string]$_.Name;CommandLine=[string]$_.CommandLine;CreationDate=$_.CreationDate.ToUniversalTime().ToString("o")} }'
  Query ([scriptblock]::Create($code)) $limitSec
}
# verbatim df2e58f2 L214-217
function ById($procId, [double]$limitSec = 15) {
  if ($TR) { Get-CimInstance Win32_Process -Filter "ProcessId=$procId" -OperationTimeoutSec 20 }
  else { ProcessRows ("ProcessId=" + [int]$procId) $limitSec }
}
# verbatim df2e58f2 L218-220
function Same($procId, $start, $name, $pat, $parent, [double]$limitSec = 15) {
  $p = ById $procId $limitSec
  return [bool]($p -and (Utc $p) -eq $start -and [string]$p.Name -eq $name -and [string]$p.CommandLine -like $pat -and ($parent -eq 0 -or [int]$p.ParentProcessId -eq $parent)) }
# verbatim df2e58f2 L221-231
function NodeProcs([double]$limitSec = 15) {
  if ($TR) {
    $cm = @(Get-CimInstance Win32_Process -Filter "Name='cmd.exe'" -OperationTimeoutSec 20 | Where-Object { [string]$_.CommandLine -like $RUN_PAT })
    $nd = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -OperationTimeoutSec 20 | Where-Object { [string]$_.CommandLine -like $AGENT_PAT })
  } else {
    $all = @(ProcessRows "Name='cmd.exe' OR Name='node.exe'" $limitSec)
    $cm = @($all | Where-Object { $_.Name -eq 'cmd.exe' -and $_.CommandLine -like $RUN_PAT })
    $nd = @($all | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -like $AGENT_PAT })
  }
  [ordered]@{ cmd = @($cm | ForEach-Object { [ordered]@{ pid = [int]$_.ProcessId; start = (Utc $_) } })
              agent = @($nd | ForEach-Object { [ordered]@{ pid = [int]$_.ProcessId; parent = [int]$_.ParentProcessId; start = (Utc $_) } }) } }
# verbatim df2e58f2 L232-234
function Privacy([double]$limitSec = 15) {
  $all = $(if ($TR) { @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -OperationTimeoutSec 20) } else { @(ProcessRows "Name='node.exe'" $limitSec) })
  @($all | Where-Object { [string]$_.CommandLine -match 'privacy-agent\.mjs' } | ForEach-Object { [ordered]@{ pid = [int]$_.ProcessId; start = (Utc $_) } }) }
# verbatim df2e58f2 L235-241
function Listeners([int]$port, [double]$limitSec = 15) {
  if ($TR) { Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction Stop }
  else {
    $code = 'Get-CimInstance -Namespace root/StandardCimv2 -ClassName MSFT_NetTCPConnection -Filter "LocalPort=' + $port + ' AND State=2" -OperationTimeoutSec 5 | ForEach-Object { [ordered]@{OwningProcess=[int]$_.OwningProcess} }'
    Query ([scriptblock]::Create($code)) $limitSec
  }
}
# verbatim df2e58f2 L242-243
function Manager { $c = @(Listeners 8091)
  if ($c.Count -ne 1) { return 'unavailable' }; $p = ById $c[0].OwningProcess; if (-not $p) { return 'unavailable' }; "$($p.ProcessId)@$(Utc $p)" }
# verbatim df2e58f2 L251-257
function HostState([double]$limitSec = 10) {
  if ($TR) { return (Invoke-RestMethod -UseBasicParsing -TimeoutSec 5 -Uri 'http://127.0.0.1:9600/v1/host/state') }
  Query {
    $h = Invoke-RestMethod -UseBasicParsing -TimeoutSec 5 -Uri 'http://127.0.0.1:9600/v1/host/state'
    [ordered]@{ deployments = @($h.deployments | ForEach-Object { [ordered]@{id=$_.id;status=$_.status;leaseUntil=$_.leaseUntil} }); leaseReadiness=$h.leaseReadiness }
  } $limitSec
}
# verbatim df2e58f2 L258-264
function Vms {
  try {
    if ($TR) { $rows = @((Invoke-RestMethod -UseBasicParsing -TimeoutSec 5 -Uri 'http://127.0.0.1:8091/vms').vms) }
    else { $rows = @(Query { (Invoke-RestMethod -UseBasicParsing -TimeoutSec 5 -Uri 'http://127.0.0.1:8091/vms').vms | ForEach-Object { [ordered]@{id=$_.id;name=$_.name;status=$_.status} } } 10) }
    @($rows | ForEach-Object { "$($_.id)|$($_.name)|$($_.status)" } | Sort-Object) -join ','
  } catch { if ($script:QueryCleanupFailed) { throw }; 'unavailable' }
}
# verbatim df2e58f2 L266-266
function Known($v) { $v -and $v -ne 'unavailable' }      # 'unavailable' never compares as unchanged
# verbatim df2e58f2 L267-271
function ReadinessNumber($v) {
  return [bool](($v -is [int] -or $v -is [long] -or $v -is [double] -or $v -is [decimal]) -and
    -not [double]::IsNaN([double]$v) -and -not [double]::IsInfinity([double]$v) -and
    [double]$v -ge 0 -and [double]$v -le 9007199254740991 -and [math]::Floor([double]$v) -eq [double]$v)
}
# verbatim df2e58f2 L272-292
function LeaseReady($h, $sinceMs) {
  $r = $h.leaseReadiness; $now = NowMs; $ids = @($PRM.expectedIds)
  if (-not $r) { return $false }
  foreach ($key in 'sequence','startedAt','completedAt') { if (-not (ReadinessNumber $r.$key)) { return $false } }
  if (-not $ids.Count -or -not $r -or $r.inFlight -ne $false -or [int64]$r.sequence -le 0 -or
      [int64]$r.startedAt -lt $sinceMs -or [int64]$r.completedAt -lt [int64]$r.startedAt -or
      [int64]$r.completedAt -gt $now -or $now - [int64]$r.completedAt -ge 5000) { return $false }
  foreach ($id in $ids) {
    $checks = @($r.deployments | Where-Object { [string]$_.id -eq [string]$id })
    $rows = @($h.deployments | Where-Object { [string]$_.id -eq [string]$id })
    if ($checks.Count -ne 1 -or $rows.Count -ne 1) { return $false }
    $c = $checks[0]; $d = $rows[0]
    foreach ($key in 'sequence','observedAt','checkedAt','leaseUntil') { if (-not (ReadinessNumber $c.$key)) { return $false } }
    if (-not (ReadinessNumber $d.leaseUntil)) { return $false }
    if ([string]$c.status -ne 'ready' -or [string]$d.status -ne 'running' -or [string]$c.runner -ne [string]$PRM.runner -or
        [int64]$c.sequence -ne [int64]$r.sequence -or [int64]$c.observedAt -lt [int64]$r.startedAt -or
        [int64]$c.checkedAt -lt [int64]$c.observedAt -or [int64]$c.checkedAt -gt [int64]$r.completedAt -or
        [double]$c.leaseUntil -ne [double]$d.leaseUntil -or [double]$c.leaseUntil -le (NowS) + [int]$PRM.lease.marginSec) { return $false }
  }
  return $true
}
# verbatim df2e58f2 L293-297
function OwnsAgentPort($agent, $lim) {
  if (-not (PollRoom $lim)) { return $false }
  $listeners = @(Listeners 9600 (($lim - (Get-Date)).TotalSeconds))
  return [bool]((Get-Date) -lt $lim -and $listeners.Count -eq 1 -and [int]$listeners[0].OwningProcess -eq [int]$agent.pid)
}
# verbatim df2e58f2 L298-312
function AgentUp($agent, [double]$limitSec = 15) {
  # Listener ownership and HTTP responses share ONE phase deadline; neither gets a fresh budget after the other.
  # Ownership is proven BEFORE the host-state polls and AGAIN after the ready one (the ready answer is bracketed).
  $lim = (Get-Date).AddSeconds((Lim $limitSec))
  try {
    if (-not (OwnsAgentPort $agent $lim)) { return $false }
    while ($true) {
      if (-not (PollRoom $lim)) { return $false }
      $h = HostState (($lim - (Get-Date)).TotalSeconds)
      if ((Get-Date) -ge $lim) { return $false }
      if (LeaseReady $h (IsoMs $agent.start)) { return (OwnsAgentPort $agent $lim) }
      Start-Sleep -Seconds 1
    }
  } catch { if ($script:QueryCleanupFailed) { throw }; return $false }
}
# verbatim df2e58f2 L315-320
function LogFrom($offset, $pats) {   # COUNTS of patterns in node.log lines written after $offset (never the lines)
  $o = [ordered]@{}; foreach ($k in $pats) { $o[$k] = 0 }
  try { $fs = [IO.File]::Open($NODELOG, 'Open', 'Read', 'ReadWrite,Delete'); try { if ($fs.Length -lt $offset) { $o.rotated = $true; $offset = 0 }; [void]$fs.Seek($offset, 'Begin')
        $t = (New-Object IO.StreamReader($fs)).ReadToEnd() } finally { $fs.Close() }
        foreach ($k in $pats) { $o[$k] = ([regex]::Matches($t, [regex]::Escape($k))).Count } } catch { $o.error = 'node.log unreadable' }
  return $o }
# verbatim df2e58f2 L354-365
function WaitNodeGone($pin, $name, $pat, $parent, $limitSec) {
  $lim = (Get-Date).AddSeconds((Lim $limitSec))
  while ((Get-Date) -lt $lim) {
    if (-not (PollRoom $lim)) { return $false }
    $same = Same $pin.pid $pin.start $name $pat $parent (($lim - (Get-Date)).TotalSeconds)
    # A query that returns too late is not proof obtained inside this budget.
    if ((Get-Date) -ge $lim) { return $false }
    if (-not $same) { return $true }
    Start-Sleep -Milliseconds 500
  }
  return $false
}
# verbatim df2e58f2 L368-392
function Invoke-TaskCommand([ValidateSet('Start','Stop')][string]$Action, [string]$TaskPath, [string]$TaskName, [int]$BudgetMs = 20000) {
  if ($BudgetMs -lt 2500 -or $BudgetMs -gt 30000) { throw 'task request budget must include cleanup time' }
  $quote = { param($s) "'" + $s.Replace("'", "''") + "'" }
  $body = '$ErrorActionPreference="Stop";$ProgressPreference="SilentlyContinue";try{' + $Action + '-ScheduledTask -TaskPath ' + (& $quote $TaskPath) + ' -TaskName ' + (& $quote $TaskName) + ';exit 0}catch{exit 2}'
  $sw=[Diagnostics.Stopwatch]::StartNew();$si=New-Object Diagnostics.ProcessStartInfo
  $si.FileName=Join-Path $PSHOME $(if($env:OS -eq 'Windows_NT'){'powershell.exe'}else{'pwsh'})
  $si.Arguments='-NoProfile -NonInteractive -EncodedCommand '+[Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($body))
  $si.UseShellExecute=$false;$si.CreateNoWindow=$true;$si.RedirectStandardOutput=$true;$si.RedirectStandardError=$true
  $p=New-Object Diagnostics.Process;$p.StartInfo=$si;$started=$false;$exited=$false;$confirmed=$false;$timedOut=$false
  try {
    $started=$p.Start()
    if($started){
      $stdout=$p.StandardOutput.ReadToEndAsync();$stderr=$p.StandardError.ReadToEndAsync()
      $left=[math]::Max(0,$BudgetMs-2000-$sw.ElapsedMilliseconds);$exited=$p.WaitForExit([int]$left)
      if($exited){$confirmed=$p.ExitCode -eq 0}else{$timedOut=$true}
    }
  } catch { $confirmed=$false }
  finally {
    if($started -and -not $p.HasExited){try{$p.Kill()}catch{};$left=[math]::Max(0,$BudgetMs-$sw.ElapsedMilliseconds);$exited=$p.WaitForExit([int]$left)}
    elseif($started){$exited=$true}
    $childId=$(if($started){$p.Id}else{$null});$p.Dispose()
  }
  if($sw.ElapsedMilliseconds -gt $BudgetMs){$confirmed=$false;$timedOut=$true}
  [pscustomobject]@{action=$Action;responseConfirmed=($confirmed -and $exited);outcome=$(if($confirmed -and $exited){'response-confirmed'}elseif($started){'unknown'}else{'not-started'});childId=$childId;childExited=$exited;timedOut=$timedOut;elapsedMs=$sw.ElapsedMilliseconds}
}
# verbatim df2e58f2 L393-404
function NodeTask([ValidateSet('Start','Stop')][string]$Action, [double]$limitSec = 20) {
  if($script:TaskMutationUnknown){throw 'previous task outcome unknown; no automatic retry'}
  if($TR){
    if($Action -eq 'Start'){Start-ScheduledTask -TaskPath '\Enclave\' -TaskName 'Node'}
    else{Stop-ScheduledTask -TaskPath '\Enclave\' -TaskName 'Node'}
    return
  }
  $ms=[int][math]::Floor(1000*(Lim ([math]::Min(20,$limitSec))))
  if($ms -lt 2500){throw 'not enough time to send a task request and confirm child cleanup'}
  $script:LastTaskCommand=Invoke-TaskCommand $Action '\Enclave\' 'Node' $ms
  if(-not $script:LastTaskCommand.responseConfirmed){$script:TaskMutationUnknown=$true;throw 'task request outcome unconfirmed; no automatic retry or rollback'}
}
# verbatim df2e58f2 L406-431
function StopNode($cmd, $agent) {
  # One fresh snapshot checks both identities together and refuses duplicate launchers/agents.
  $script:LastStopProofAt = $null
  $p = NodeProcs
  if ($p.cmd.Count -ne 1 -or $p.agent.Count -ne 1 -or $p.cmd[0].pid -ne $cmd.pid -or $p.cmd[0].start -ne $cmd.start -or
      $p.agent[0].pid -ne $agent.pid -or $p.agent[0].start -ne $agent.start -or $p.agent[0].parent -ne $cmd.pid) { return 'identity changed; nothing stopped' }
  if ($Fwd -and $phase -eq 'pins') { $refusal = BeforeStop; if ($refusal) { return ('REFUSED: ' + $refusal) } }
  # A task API may stop the task and then throw. Mark the mutation boundary BEFORE invoking it.
  if ($phase -eq 'pins') { $script:phase = 'stopping' }
  NodeTask 'Stop'
  if (-not (WaitNodeGone $cmd 'cmd.exe' $RUN_PAT 0 30)) { return 'the run-node cmd.exe did not verifiably stop inside its budget' }
  if (-not (WaitNodeGone $agent 'node.exe' $AGENT_PAT $cmd.pid 30)) {
    NeedForward
    $same = Same $agent.pid $agent.start 'node.exe' $AGENT_PAT $cmd.pid
    NeedForward
    if ($same) {
      Stop-Process -Id $agent.pid -Force
      if (-not (WaitNodeGone $agent 'node.exe' $AGENT_PAT $cmd.pid 10)) { return 'the old agent did not verifiably stop inside its budget' }
    }
  }
  # A stopped result itself proves BOTH process sets empty; callers consume this proof immediately.
  $p = NodeProcs
  if ($p.cmd.Count -ne 0 -or $p.agent.Count -ne 0) { return 'node processes remain after the stop' }
  $script:LastStopProofAt = Now
  return 'stopped'
}
# verbatim df2e58f2 L432-432
function NodeStopped { $q = NodeProcs; return ($q.cmd.Count -eq 0 -and $q.agent.Count -eq 0) }
# verbatim df2e58f2 L530-533
function Identity($o) {   # the post-check of everything this run must not have changed
  $o.hypervUnchanged = (Known $hv0) -and ((HyperV) -eq $hv0); $o.managerVmsUnchanged = (Known $vms0) -and ((Vms) -eq $vms0)
  $o.managerUnchanged = (Known $mg) -and ((Manager) -eq $mg); $o.othersUnchanged = ((Others) -eq $others0)
  return ($o.hypervUnchanged -and $o.managerVmsUnchanged -and $o.managerUnchanged -and $o.othersUnchanged) }

# ---------------------------------------------------------------- MODIFIED / NEW for the node-only pair window
# MODIFIED Others: ONE bounded child read (the cutover's direct Get-ScheduledTask + 30-s CIM scan had no deadline), and every
# \Enclave\ task except Node itself (a node-only window also leaves \Enclave\Network unchanged)
function Others([double]$limitSec = 15) {
  if ($TR) { $all = @(Get-CimInstance Win32_Process -OperationTimeoutSec 30)
    return (@(Get-ScheduledTask -TaskPath '\Enclave\' | Where-Object { $_.TaskName -ne 'Node' } | Sort-Object TaskName | ForEach-Object {
      $f = [regex]::Match([string]$_.Actions[0].Arguments + ' ' + [string]$_.Actions[0].Execute, '[^"\\ ]+\.(cmd|ps1|mjs|exe|json)').Value
      $ps = @(if ($f) { $all | Where-Object { [string]$_.CommandLine -like "*$f*" } | Sort-Object ProcessId | ForEach-Object { '{0}@{1}' -f $_.ProcessId, $_.CreationDate.ToUniversalTime().ToString('o') } })
      '{0}={1}:{2}' -f $_.TaskName, [string]$_.State, ($ps -join '+') }) -join ',') }
  @(Query {
    $all = @(Get-CimInstance Win32_Process -OperationTimeoutSec 8)
    @(Get-ScheduledTask -TaskPath '\Enclave\' -ErrorAction Stop | Where-Object { $_.TaskName -ne 'Node' } | Sort-Object TaskName | ForEach-Object {
      $f = [regex]::Match([string]$_.Actions[0].Arguments + ' ' + [string]$_.Actions[0].Execute, '[^"\\ ]+\.(cmd|ps1|mjs|exe|json)').Value
      $ps = @(if ($f) { $all | Where-Object { [string]$_.CommandLine -like "*$f*" } | Sort-Object ProcessId | ForEach-Object { '{0}@{1}' -f $_.ProcessId, $_.CreationDate.ToUniversalTime().ToString('o') } })
      '{0}={1}:{2}' -f $_.TaskName, [string]$_.State, ($ps -join '+') }) -join ',' } $limitSec)[0] }
# MODIFIED HyperV: the same identity string through the bounded child reader
function HyperV([double]$limitSec = 15) {
  try {
    if ($TR) { return (@(Get-VM -ErrorAction Stop | ForEach-Object { '{0}|{1}|{2}' -f $_.Id, $_.Name, $_.State } | Sort-Object) -join ',') }
    @(Query { @(Get-VM -ErrorAction Stop | ForEach-Object { '{0}|{1}|{2}' -f $_.Id, $_.Name, $_.State } | Sort-Object) -join ',' } $limitSec)[0]
  } catch { if ($script:QueryCleanupFailed) { throw }; 'unavailable' } }
# NEW: the \Enclave\Node task action, read through the bounded child
function TaskAction([double]$limitSec = 10) {
  if ($TR) { $t = Get-ScheduledTask -TaskPath '\Enclave\' -TaskName 'Node' -ErrorAction Stop
    return [ordered]@{ count = @($t.Actions).Count; execute = [string]$t.Actions[0].Execute; arguments = [string]$t.Actions[0].Arguments } }
  @(Query { $t = Get-ScheduledTask -TaskPath '\Enclave\' -TaskName 'Node' -ErrorAction Stop
    [ordered]@{ count = @($t.Actions).Count; execute = [string]$t.Actions[0].Execute; arguments = [string]$t.Actions[0].Arguments } } $limitSec)[0] }
# NEW: the updater must also stay quiet through root's reserved rollback (lease.revertSec), not only through this run
function UpdateHorizon($v) {
  if ([string]$v.state -eq 'Disabled') { return $null }
  $t = $null; try { $t = [DateTimeOffset]::Parse((Iso $v.next)).UtcDateTime } catch {}
  if ($null -eq $t -or $t -lt (Get-Date).ToUniversalTime().AddSeconds($BoundSec + [int]$PRM.lease.revertSec + 60)) { return 'the \Enclave\Update task is due before this run and the reserved rollback could finish' }
  return $null }
# NEW: the node-wide restart stops EVERY running deployment, so expectedIds must be EXACTLY the set the node runs: an
# expected id that is not running, or a running one that is not expected, refuses (at the pins and again before the stop)
function RunningSetDiff($h) {
  $exp = @(@($PRM.expectedIds) | ForEach-Object { ([string]$_).ToLower() } | Sort-Object -Unique)
  $run = @(@($h.deployments) | Where-Object { $_ -and [string]$_.status -eq 'running' } | ForEach-Object { ([string]$_.id).ToLower() } | Sort-Object -Unique)
  $extra = @($run | Where-Object { $exp -notcontains $_ }); $missing = @($exp | Where-Object { $run -notcontains $_ })
  if (@($PRM.expectedIds).Count -ne $exp.Count) { return 'expectedIds repeats an id' }
  if ($extra.Count -or $missing.Count) { return "the running deployments are not exactly expectedIds (running but not expected: $($extra -join ','); expected but not running: $($missing -join ','))" }
  return $null }
# NEW: the files this run must NOT change (configs, launcher, other node modules), each == its pinned sha
function UnchangedFiles { $bad = @(foreach ($f in @($PRM.unchangedFiles)) { if ((Sha ([string]$f.path)) -ne [string]$f.sha) { [string]$f.path } })
  if ($bad.Count) { return 'not as pinned: ' + ($bad -join ', ') }; return $null }
# NEW: the pair as it is on disk now -> 'from' | 'to' | 'mixed:<shas>'
function PairNow {
  $s = @(foreach ($f in $Files) { Sha $f.target })
  if (@(for ($i = 0; $i -lt $Files.Count; $i++) { if ($s[$i] -ne $Files[$i].from) { 1 } }).Count -eq 0) { return 'from' }
  if (@(for ($i = 0; $i -lt $Files.Count; $i++) { if ($s[$i] -ne $Files[$i].to) { 1 } }).Count -eq 0) { return 'to' }
  return 'mixed:' + ($s -join ',') }
# MODIFIED BeforeStop: the cutover's guard (updater, every expected lease, forward budget) with the pinned FILES of this run
# (both targets still the FROM pair, the unchanged files as pinned) instead of the cutover's three configs
function BeforeStop {
  try {
    $uv = $null; try { $uv = UpdateState 10 } catch { if ($script:QueryCleanupFailed) { throw } }
    $ur = UpdateDecision $uv; if ($ur) { return $ur + '; nothing stopped' }
    $uh = UpdateHorizon $uv; if ($uh) { return $uh + '; nothing stopped' }
    $h = HostState 10
    $ids = @($PRM.expectedIds); if (-not $ids.Count) { return 'no expected deployments' }
    $rs = RunningSetDiff $h; if ($rs) { return "$rs; nothing stopped" }
    $ends = @()
    foreach ($id in $ids) {
      $rows = @($h.deployments | Where-Object { [string]$_.id -eq [string]$id })
      if ($rows.Count -ne 1 -or [string]$rows[0].status -ne 'running') { return 'a deployment is missing, duplicated, or not running' }
      $v = $rows[0].leaseUntil
      if (-not ($v -is [int] -or $v -is [long] -or $v -is [double] -or $v -is [decimal]) -or
          [double]::IsNaN([double]$v) -or [double]::IsInfinity([double]$v) -or [double]$v -le 0 -or [math]::Floor([double]$v) -ne [double]$v) { return 'a lease deadline is invalid' }
      $ends += [int64]$v
    }
    $script:LeaseEnd = ($ends | Measure-Object -Minimum).Minimum
    if ((PairNow) -ne 'from') { return 'the two modules are no longer the pinned FROM pair; nothing stopped' }
    $uf = UnchangedFiles; if ($uf) { return "$uf; nothing stopped" }
    if ((ForwardLeft) -lt [int]$PRM.lease.forwardMinSec) { return 'lease/global forward budget insufficient immediately before stop' }
    return $null
  } catch { return 'fresh lease read unavailable immediately before stop' }
}
# MODIFIED StartNode: as the cutover's, plus the new launcher must be a child of the PINNED Task Scheduler process, and both
# new identities must differ from the stopped ones (PID+start: a reused PID with another start is a new process). A launcher
# that fails either is never accepted (the run ends NOT READY; nothing is killed or retried).
function StartNode($limitSec) {
  $budget = Lim $limitSec; if ($budget -le 0) { return $null }
  $lim = (Get-Date).AddSeconds($budget); $n = $null
  NodeTask 'Start' (($lim - (Get-Date)).TotalSeconds)
  while (-not $n -and (Get-Date) -lt $lim) {
    if (-not (PollRoom $lim)) { return $null }
    $q = NodeProcs (($lim - (Get-Date)).TotalSeconds); if ((Get-Date) -ge $lim) { return $null }
    if ($q.cmd.Count -eq 1 -and $q.agent.Count -eq 1 -and $q.agent[0].parent -eq $q.cmd[0].pid) {
      $script:NewLaunch = $q
      if (-not (PollRoom $lim)) { return $null }
      if (NewIdentity $q (($lim - (Get-Date)).TotalSeconds)) { $n = $q } else { return $null } }
    else { Start-Sleep -Milliseconds 500 }
  }
  while ($n -and (Get-Date) -lt $lim) {
    $up = AgentUp $n.agent[0] (($lim - (Get-Date)).TotalSeconds)
    if ((Get-Date) -ge $lim) { return $null }
    if ($up) { return [ordered]@{ cmd = $n.cmd[0]; agent = $n.agent[0] } }
    Start-Sleep -Seconds 1
  }
  return $null
}
function NewIdentity($q, [double]$limitSec) {
  $c = $q.cmd[0]; $a = $q.agent[0]
  if (($c.pid -eq [int]$PRM.node.cmdPid -and $c.start -eq (Iso $PRM.node.cmdStart)) -or ($a.pid -eq [int]$PRM.node.agentPid -and $a.start -eq (Iso $PRM.node.agentStart))) {
    $script:StartRefusal = 'a stopped identity is running again'; return $false }
  $row = ById $c.pid $limitSec
  if (-not $row -or (Utc $row) -ne $c.start -or [int]$row.ParentProcessId -ne [int]$PRM.scheduler.pid) {
    $script:StartRefusal = 'the new run-node cmd.exe is not a child of the pinned Task Scheduler process'; return $false }
  return $true }
# NEW: one bundle-swap.ps1 child (the pinned bytes, re-hashed by the child itself before it runs them), bounded like
# Invoke-TaskCommand. A child whose exit is not confirmed, or that wrote no decision, is an UNKNOWN outcome.
function Invoke-SwapChild([hashtable]$SwapArgs, [int]$BudgetMs = 30000) {
  if ($BudgetMs -lt 2500 -or $BudgetMs -gt 30000) { throw 'swap child budget must include cleanup time' }
  $quote = { param($s) "'" + ([string]$s).Replace("'", "''") + "'" }
  $splat = '@{' + (@($SwapArgs.Keys | Sort-Object | ForEach-Object { $_ + '=' + (& $quote $SwapArgs[$_]) }) -join ';') + '}'
  $pre = $(if ($TR -and $PRM.testPrelude) { '. ' + (& $quote ([string]$PRM.testPrelude)) + ';' } else { '' })
  $body = '$ErrorActionPreference="Stop";$ProgressPreference="SilentlyContinue";' + $pre +
    '$b=[IO.File]::ReadAllBytes(' + (& $quote ([string]$PRM.bundleSwap.path)) + ');if((-join([Security.Cryptography.SHA256]::Create().ComputeHash($b)|ForEach-Object{$_.ToString("x2")})) -ne ' + (& $quote ([string]$PRM.bundleSwap.sha)) + '){exit 3};' +
    '$a=' + $splat + ';& ([scriptblock]::Create([Text.Encoding]::UTF8.GetString($b))) @a'
  $sw=[Diagnostics.Stopwatch]::StartNew();$si=New-Object Diagnostics.ProcessStartInfo
  $si.FileName=Join-Path $PSHOME $(if($env:OS -eq 'Windows_NT'){'powershell.exe'}else{'pwsh'})
  $si.Arguments='-NoProfile -NonInteractive -EncodedCommand '+[Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($body))
  $si.UseShellExecute=$false;$si.CreateNoWindow=$true;$si.RedirectStandardOutput=$true;$si.RedirectStandardError=$true
  $p=New-Object Diagnostics.Process;$p.StartInfo=$si;$started=$false;$exited=$false;$timedOut=$false;$out=$null;$code=$null
  try {
    $started=$p.Start()
    if($started){
      $stdout=$p.StandardOutput.ReadToEndAsync();$stderr=$p.StandardError.ReadToEndAsync()
      $left=[math]::Max(0,$BudgetMs-2000-$sw.ElapsedMilliseconds);$exited=$p.WaitForExit([int]$left)
      if($exited){$code=$p.ExitCode;$left=[math]::Max(0,$BudgetMs-2000-$sw.ElapsedMilliseconds);if($stdout.Wait([int]$left)){$out=[string]$stdout.Result}}else{$timedOut=$true}
    }
  } catch { $out=$null }
  finally {
    if($started -and -not $p.HasExited){try{$p.Kill()}catch{};$left=[math]::Max(0,$BudgetMs-$sw.ElapsedMilliseconds);$exited=$p.WaitForExit([int]$left)}
    elseif($started){$exited=$true}
    $childId=$(if($started){$p.Id}else{$null});$p.Dispose()
  }
  if($sw.ElapsedMilliseconds -gt $BudgetMs){$timedOut=$true}
  $doc=$null; if($out){ $line=@($out -split "`n" | Where-Object { $_.Trim().StartsWith('{') })[-1]; if($line){ try { $doc = ConvertFrom-Json -InputObject $line } catch {} } }
  [pscustomobject]@{started=$started;exited=$exited;timedOut=$timedOut;exitCode=$code;decision=$(if($doc){[string]$doc.decision}else{$null});childId=$childId;elapsedMs=$sw.ElapsedMilliseconds}
}
# NEW: the swap journal bundle-swap.ps1 keeps in <WorkDir>\.bundle-swap\journal.json (state only; never file content)
function SwapJournal($f) { try { [string](([IO.File]::ReadAllText((Join-Path (Join-Path $f.workDir '.bundle-swap') 'journal.json'))) | ConvertFrom-Json).state } catch { 'absent' } }
# NEW: ONE per-file step through bundle-swap.ps1, judged by the coordinator's own reads -> 'done' | 'unchanged' | 'unknown'
#   op 'apply'    old -> new: -Mode apply  -OldSha old -NewFile staged -NewSha new
#   op 'rollback' new -> old: -Mode rollback -OldSha old -ExpectCurrent new (the backup in the same work directory)
# done      : child exit confirmed (code 0), its decision the success text, target == the step's after-sha, journal closed
# unchanged : child exit confirmed, target == the step's before-sha, journal not 'started' (bundle-swap closes a failed apply as
#             'aborted-unchanged' and leaves a refused one untouched)
# anything else is unknown, including a 'noop' (the bytes changed without this step)
function SwapStep($f, [ValidateSet('apply','rollback')][string]$op) {
  $before = $(if ($op -eq 'apply') { $f.old } else { $f.new }); $after = $(if ($op -eq 'apply') { $f.new } else { $f.old })
  $a = @{ Mode = $op; Target = $f.target; WorkDir = $f.workDir; OldSha = $f.old; Node = $NodeExe }
  if ($op -eq 'apply') { $a.NewFile = $f.newFile; $a.NewSha = $f.new } else { $a.ExpectCurrent = $f.new }
  $ms = [int][math]::Floor(1000 * (Lim 30))
  if ($ms -lt 2500) { return [ordered]@{ file = $f.name; op = $op; result = 'not-started'; why = 'no time left for a bounded swap child' } }
  $c = Invoke-SwapChild $a $ms
  $now = Sha $f.target; $js = SwapJournal $f
  $okText = $(if ($op -eq 'apply') { 'applied*' } else { 'rolled back' }); $okState = $(if ($op -eq 'apply') { 'done' } else { 'rolled-back' })
  $r = [ordered]@{ file = $f.name; op = $op; decision = $c.decision; exitCode = $c.exitCode; childExited = $c.exited; timedOut = $c.timedOut; target = $now; journal = $js; elapsedMs = $c.elapsedMs }
  if (-not $c.started) { $r.result = 'unchanged-not-started'; if ($now -ne $before) { $r.result = 'unknown' }; return $r }
  if ($c.exited -and -not $c.timedOut -and $c.exitCode -eq 0 -and $c.decision -like $okText -and $now -eq $after -and $js -eq $okState) { $r.result = 'done' }
  elseif ($c.exited -and -not $c.timedOut -and $now -eq $before -and $js -ne 'started' -and $c.decision -notlike 'noop*') { $r.result = 'unchanged' }
  else { $r.result = 'unknown' }
  return $r }
# NEW: the pair transition FROM -> TO with conclusive per-step outcomes -> 'to' | 'from' | 'unknown' (+ steps journaled)
function SwapPair([ValidateSet('apply','rollback')][string]$op) {
  $order = $(if ($op -eq 'apply') { @(0, 1) } else { @(1, 0) }); $inv = $(if ($op -eq 'apply') { 'rollback' } else { 'apply' })
  $done = @(); $steps = @()
  foreach ($i in $order) {
    $s = SwapStep $Files[$i] $op; $steps += $s; Log ([ordered]@{ step = 'swap'; detail = $s })
    if ($s.result -eq 'done') { $done += $i; continue }
    if ($s.result -notin 'unchanged', 'unchanged-not-started') { $script:FileMutationUnknown = $true; return [ordered]@{ pair = 'unknown'; steps = $steps; why = "the $($s.file) step outcome is not proven" } }
    # a conclusive no-change: undo ONLY the earlier PROVEN steps, newest first, each again proven
    for ($k = $done.Count - 1; $k -ge 0; $k--) {
      $u = SwapStep $Files[$done[$k]] $inv; $steps += $u; Log ([ordered]@{ step = 'undo'; detail = $u })
      if ($u.result -ne 'done') { $script:FileMutationUnknown = $true; return [ordered]@{ pair = 'unknown'; steps = $steps; why = "the undo of the proven $($u.file) step is not proven: a MIXED pair may be on disk" } }
    }
    return [ordered]@{ pair = 'from'; steps = $steps; why = "the $($s.file) step did not apply ($($s.decision)); earlier proven steps undone" }
  }
  return [ordered]@{ pair = 'to'; steps = $steps } }
# NEW: the outcome record of any run that cannot be completed: the actual state, read with what time is left
function Recovery($what, $x, $label = 'RECOVERY_REQUIRED') {
  $x.taskCommand = $script:LastTaskCommand; $x.recovery = $what
  if ($terminal) { $x.terminalReturn = 'TERMINAL RETURN: NO return reserve remains after this rollback run; root decides manually' }
  $x.nodeNow = $(try { NodeProcs 10 } catch { 'unknown: ' + $_.Exception.Message })
  $x.listener9600 = $(try { @(Listeners 9600 10 | ForEach-Object { [int]$_.OwningProcess }) } catch { 'unknown: ' + $_.Exception.Message })
  $x.pairNow = $(try { PairNow } catch { 'unknown' }); $x.shas = $(try { @(foreach ($f in $Files) { [ordered]@{ file = $f.name; sha = (Sha $f.target); journal = (SwapJournal $f) } }) } catch { 'unknown' })
  $x.unchangedFiles = $(try { UnchangedFiles } catch { 'unknown' })
  $x.leaseFirstEnd = $LeaseEnd; $x.leaseSecLeft = $(if ($null -ne $LeaseEnd) { $LeaseEnd - (NowS) } else { $null })
  Final ("${label}: $what") $x }

trap {
  $script:Fwd = $false
  $x = [ordered]@{ phase = $phase; error = $_.Exception.Message }
  if ($script:TaskMutationUnknown) { Recovery 'a task request outcome is unknown; no automatic retry, start, swap or rollback; the actual state is recorded' $x }
  if ($script:FileMutationUnknown) { Recovery 'a swap outcome is unknown; nothing more is written and the node is NOT started' $x }
  if ($phase -eq 'pins') { $x.final = 'CRASHED in phase pins: nothing was stopped or written; root decides'; Log $x; exit 1 }
  if ($phase -eq 'verified') { $x.final = 'CRASHED in phase verified: the node was proven ready on a consistent pair; a post-check could not run; root decides'; Log $x; exit 1 }
  Recovery "a terminating error in phase ${phase}; this run starts, swaps and rolls back nothing more; root decides from the recorded state" $x }

# ---------------------------------------------------------------- common: the lock, the pinned files and modules
$lock = Join-Path $Stage ("pair-$Mode-$Run.lock")
try { $fs = [IO.File]::Open($lock, 'CreateNew', 'Write'); $fs.Close() } catch { Log ([ordered]@{ step = 'lock'; decision = 'REFUSED: this run id already ran (lock exists)' }); exit 0 }
$NodeExe = $(if ($TR) { [string]$PRM.testNode } else { [string]$PRM.nodeExe })
# the two files: EXACTLY chain.mjs and host.mjs in the node directory, each with old/new sha, its staged new bytes and its own
# bundle-swap work directory (distinct, inside the stage); FROM/TO by mode
$why = @(); $Files = @()
$byName = @{}; foreach ($f in @($PRM.files)) { $byName[[string]$f.name] = $f }
if (@($PRM.files).Count -ne 2 -or @($byName.Keys).Count -ne 2) { $why += 'the params must name exactly two files' }
foreach ($nm in $PAIR) {
  $f = $byName[$nm]
  if (-not $f) { $why += "the params do not name $nm"; continue }
  $tg = Join-Path $NODEDIR $nm
  if ([string]$f.target -ne $tg) { $why += "$nm must target exactly $tg" }
  if ([string]$f.oldSha -notmatch '^[0-9a-f]{64}$' -or [string]$f.newSha -notmatch '^[0-9a-f]{64}$' -or [string]$f.oldSha -eq [string]$f.newSha) { $why += "$nm needs two different lowercase sha256 values" }
  $wd = [string]$f.workDir; $nf = [string]$f.newFile
  if (-not $wd.StartsWith($Stage + [IO.Path]::DirectorySeparatorChar) -or -not $nf.StartsWith($Stage + [IO.Path]::DirectorySeparatorChar)) { $why += "$nm work directory and staged file must be inside the stage" }
  $Files += [pscustomobject]@{ name = $nm; target = $tg; old = [string]$f.oldSha; new = [string]$f.newSha; newFile = $nf; workDir = $wd
    from = $(if ($Mode -eq 'rollback') { [string]$f.newSha } else { [string]$f.oldSha }); to = $(if ($Mode -eq 'rollback') { [string]$f.oldSha } else { [string]$f.newSha }) }
}
if ($Files.Count -eq 2 -and $Files[0].workDir -eq $Files[1].workDir) { $why += 'each file needs its own bundle-swap work directory' }
if ((Sha ([string]$PRM.bundleSwap.path)) -ne [string]$PRM.bundleSwap.sha -or [string]$PRM.bundleSwap.sha -notmatch '^[0-9a-f]{64}$') { $why += 'bundle-swap.ps1 is not the pinned bytes' }
if (-not $TR -and (-not $PRM.nodeExe -or (Sha $NodeExe) -ne [string]$PRM.nodeSha)) { $why += 'the node.exe for node --check is not the pinned binary' }

# ---------------------------------------------------------------- identify (read-only)
if ($Mode -eq 'identify') {
  $o = [ordered]@{ step = 'identify'; params = $why }
  $o.files = @(foreach ($f in $Files) { [ordered]@{ file = $f.name; sha = (Sha $f.target); journal = (SwapJournal $f) } })
  $o.unchanged = @(foreach ($f in @($PRM.unchangedFiles)) { [ordered]@{ path = [string]$f.path; sha = (Sha ([string]$f.path)) } })
  $o.task = $(try { TaskAction } catch { if ($script:QueryCleanupFailed) { throw }; 'unreadable' })
  $np = NodeProcs; $o.node = $np
  $o.scheduler = $null
  if ($np.cmd.Count -eq 1) { $r = ById $np.cmd[0].pid; if ($r) { $s = ById ([int]$r.ParentProcessId)
      $o.scheduler = [ordered]@{ pid = [int]$r.ParentProcessId; start = $(if ($s) { Utc $s } else { $null }); name = $(if ($s) { [string]$s.Name } else { $null }); commandLine = $(if ($s) { [string]$s.CommandLine } else { $null }) } } }
  $o.listener9600 = @(Listeners 9600 | ForEach-Object { [int]$_.OwningProcess })
  $o.manager = Manager; $o.privacy = @(Privacy); $o.vms = Vms; $o.hyperv = HyperV; $o.others = Others
  $o.updateTask = $(try { UpdateState 10 } catch { if ($script:QueryCleanupFailed) { throw }; $null })
  $hs = $null; try { $hs = HostState 10 } catch { if ($script:QueryCleanupFailed) { throw } }
  $o.deployments = @($hs.deployments | Where-Object { $_ } | ForEach-Object { [ordered]@{ id = [string]$_.id; status = [string]$_.status; leaseUntil = $_.leaseUntil } })
  $o.leaseReadiness = $(if ($hs.leaseReadiness) { [ordered]@{ sequence = $hs.leaseReadiness.sequence; inFlight = $hs.leaseReadiness.inFlight; startedAt = $hs.leaseReadiness.startedAt; completedAt = $hs.leaseReadiness.completedAt } } else { $null })
  Final 'IDENTIFIED' $o }

# ---------------------------------------------------------------- pins (apply / rollback)
$o = [ordered]@{ step = 'pins'; mode = $Mode }
$o.pair = $(if ($Files.Count -eq 2) { PairNow } else { 'invalid' })
if ($o.pair -ne 'from') { $why += "the two modules are not the FROM pair of this mode ($($o.pair))" }
foreach ($f in $Files) {
  $js = SwapJournal $f; if ($js -eq 'started') { $why += "the $($f.name) swap journal is left started: resolve it first" }
  if ($Mode -eq 'apply') { if ((Sha $f.newFile) -ne $f.new) { $why += "the staged $($f.name) is not its new sha" } }
  else { $bk = Join-Path (Join-Path $f.workDir '.bundle-swap') ('backup-' + $f.old.Substring(0, 12) + '.mjs'); if ((Sha $bk) -ne $f.old) { $why += "the $($f.name) backup is missing or not its old sha" }
         if ((Sha $f.newFile) -ne $f.new) { $why += "the staged $($f.name) (needed to undo a partial return) is not its new sha" } }
}
$uf = UnchangedFiles; if ($uf) { $why += "unchanged files $uf" }
if (-not @($PRM.unchangedFiles).Count) { $why += 'no unchanged files pinned (at least run-node.cmd and the node config)' }
$lp = $PRM.lease
$terminal = ($lp -and [string]$lp.reserve -eq 'terminal-return')
if (-not $lp -or [int]$lp.marginSec -le 0 -or [int]$lp.forwardMinSec -le 0 -or [int]$lp.startNodeSec -le 0 -or [int]$lp.revertSec -lt 0 -or ([int]$lp.revertSec -eq 0 -and -not $terminal)) { $why += 'the lease budget (marginSec/revertSec/forwardMinSec/startNodeSec) is missing' }
else {
  if ([int]$lp.startNodeSec -lt $MIN_START_NODE) { $why += "lease.startNodeSec is below the measured first-pass time ($MIN_START_NODE s)" }
  if ([int]$lp.forwardMinSec -lt $STOP_AFTER_LEASE + $SWAP_WORST + [int]$lp.startNodeSec) { $why += "lease.forwardMinSec must cover the stop after the lease read ($STOP_AFTER_LEASE s), the swaps ($SWAP_WORST s) and lease.startNodeSec" }
  # THE RESERVE (root's explicit choice, journaled): what must still fit before the first lease ends if this run fails with the
  # node stopped. 'full-return' (default): a complete second window (>= lease.forwardMinSec). 'recovery-start': only resolving
  # the two files and starting the node through ONE completed pass (SWAP_WORST + lease.startNodeSec) - the started node's pass
  # is what renews a due lease. Process availability alone is never accepted as a reserve (renewal happens inside the pass).
  # 'full-return' also covers the RETURN run's own fresh pins (before its lease read: lease.returnPinsSec, root's measured
  # allowance; the bounded pins alone can take minutes in the worst case) - a return must stop a node that may be RUNNING.
  # 'terminal-return' (explicit, Mode rollback ONLY): this run IS the return. It needs its own full forward window + margin,
  # and reserves NOTHING after itself (revertSec 0): if it fails, no further return fits this lease cycle. Never for apply.
  $rk = $(if ($lp.reserve) { [string]$lp.reserve } else { 'full-return' }); $o.reserve = $rk
  if ($rk -notin 'full-return', 'recovery-start', 'terminal-return') { $why += "lease.reserve must be full-return, recovery-start or terminal-return, not $rk" }
  elseif ($rk -eq 'terminal-return' -and $Mode -ne 'rollback') { $why += 'lease.reserve terminal-return is only for -Mode rollback (an apply always keeps a return reserve)' }
  elseif ($rk -eq 'terminal-return' -and [int]$lp.revertSec -ne 0) { $why += 'lease.reserve terminal-return reserves nothing after itself: lease.revertSec must be 0' }
  elseif ($rk -eq 'full-return' -and ([int]$lp.returnPinsSec -le 0 -or [int]$lp.revertSec -lt [int]$lp.forwardMinSec + [int]$lp.returnPinsSec)) { $why += 'lease.revertSec must cover a complete return window: the return run''s fresh pins (lease.returnPinsSec > 0) + lease.forwardMinSec, under reserve full-return' }
  elseif ($rk -eq 'recovery-start' -and [int]$lp.revertSec -lt $SWAP_WORST + [int]$lp.startNodeSec) { $why += "lease.revertSec must cover resolving the files and one completed pass (>= $SWAP_WORST + lease.startNodeSec) under reserve recovery-start" }
}
if ($BoundSec -gt $MAX_BOUND) { $why += "boundSec above $MAX_BOUND s (the task's 20-min ExecutionTimeLimit would kill this run unbounded)" }
if ($lp -and $BoundSec -lt $STOP_WORST + $SWAP_WORST + [int]$lp.startNodeSec + $POST_WORST + 60) { $why += 'boundSec cannot hold the stop, swaps, start and post checks' }
if ($why.Count) { Final ('REFUSED: ' + ($why -join '; ')) $o }
# swap preconditions through bundle-swap itself (apply: inspect = CAS, staged sha, node --check on the exact bytes)
if ($Mode -eq 'apply') {
  $o.inspect = @(foreach ($f in $Files) { $c = Invoke-SwapChild @{ Mode = 'inspect'; Target = $f.target; WorkDir = $f.workDir; OldSha = $f.old; NewFile = $f.newFile; NewSha = $f.new; Node = $NodeExe } ([int][math]::Floor(1000 * (Lim 30)))
    [ordered]@{ file = $f.name; decision = $c.decision; exited = $c.exited; exitCode = $c.exitCode } })
  foreach ($r in $o.inspect) { if (-not $r.exited -or $r.exitCode -ne 0 -or $r.decision -ne 'would apply') { $why += "bundle-swap inspect of $($r.file): $($r.decision)" } }
  if ((PairNow) -ne 'from') { $why += 'the pair changed during the inspection' }
}
$ta = TaskAction; $o.task = $ta
if ($ta.count -ne 1 -or $ta.execute -ne [string]$PRM.task.execute -or $ta.arguments -ne [string]$PRM.task.arguments) { $why += 'the \Enclave\Node task action is not the pinned one' }
$np = NodeProcs; $o.node = $np
if ($np.cmd.Count -ne 1 -or $np.agent.Count -ne 1 -or $np.cmd[0].pid -ne [int]$PRM.node.cmdPid -or $np.cmd[0].start -ne (Iso $PRM.node.cmdStart) -or
    $np.agent[0].pid -ne [int]$PRM.node.agentPid -or $np.agent[0].start -ne (Iso $PRM.node.agentStart) -or $np.agent[0].parent -ne $np.cmd[0].pid) { $why += 'the node cmd/agent are not the pinned identities' }
$sch = $PRM.scheduler
$cr = $(if ($np.cmd.Count -eq 1) { ById $np.cmd[0].pid } else { $null })
if (-not $cr -or [int]$cr.ParentProcessId -ne [int]$sch.pid) { $why += 'the run-node cmd.exe is not a child of the pinned Task Scheduler process' }
if (-not $sch -or -not (Same ([int]$sch.pid) (Iso $sch.start) ([string]$sch.name) ([string]$sch.commandLike) 0)) { $why += 'the Task Scheduler process is not the pinned PID+start+name+command line' }
$own = @(Listeners 9600); $o.listener9600 = @($own | ForEach-Object { [int]$_.OwningProcess })
if ($own.Count -ne 1 -or [int]$own[0].OwningProcess -ne [int]$PRM.node.agentPid) { $why += 'the 127.0.0.1:9600 listener is not owned by the pinned agent alone' }
$mg = Manager; $o.manager = $mg; if (-not (Known $mg) -or $mg -ne [string]$PRM.manager) { $why += 'the manager is unavailable or not the pinned PID+start' }
$pa = @(Privacy); $o.privacy = $pa; if ($pa.Count -ne 1 -or $pa[0].pid -ne [int]$PRM.privacy.pid -or $pa[0].start -ne (Iso $PRM.privacy.start)) { $why += 'the privacy agent is not the pinned PID+start' }
$vms0 = Vms; $hv0 = HyperV; $others0 = Others
if (-not (Known $vms0) -or $vms0 -ne [string]$PRM.vms) { $why += 'the manager instance set is unavailable or not the preflight set' }
if (-not (Known $hv0) -or $hv0 -ne [string]$PRM.hyperv) { $why += 'the Hyper-V VM set is unavailable or not the preflight set' }
$logOffset = $(try { (Get-Item -LiteralPath $NODELOG).Length } catch { 0 }); $o.nodeLogOffset = $logOffset
$uv = $null; try { $uv = UpdateState 10 } catch { if ($script:QueryCleanupFailed) { throw } }
$o.updateTask = $uv; $ur = UpdateDecision $uv; if ($ur) { $why += $ur } else { $uh = UpdateHorizon $uv; if ($uh) { $why += $uh } }
$hs = $null; try { $hs = HostState 10 } catch { if ($script:QueryCleanupFailed) { throw } }
$by = @{}; foreach ($d in @($hs.deployments)) { if ($d) { $by[([string]$d.id).ToLower()] = $d } }
$ends = @(); $bad = @()
foreach ($i in @($PRM.expectedIds)) { $d = $by[([string]$i).ToLower()]; $v = $d.leaseUntil
  if ($d -and [string]$d.status -eq 'running' -and ($v -is [int] -or $v -is [long] -or $v -is [double] -or $v -is [decimal])) { $ends += [pscustomobject]@{ id = [string]$i; end = [int64]$v } } else { $bad += [string]$i } }
if (-not @($PRM.expectedIds).Count) { $why += 'no expected deployments pinned' }
if ($hs) { $rs = RunningSetDiff $hs; $o.running = @(@($hs.deployments) | Where-Object { $_ -and [string]$_.status -eq 'running' } | ForEach-Object { [string]$_.id }); if ($rs) { $why += $rs } }
if (-not $hs) { $o.lease = 'unreadable'; $why += 'the node lease state (127.0.0.1:9600/v1/host/state) is unreadable' }
elseif ($bad.Count) { $o.lease = [ordered]@{ notRunningOrNoLease = $bad }; $why += "expected ids without a running record and a numeric leaseUntil: $($bad -join ',')" }
elseif ($ends.Count) { $first = @($ends | Sort-Object end)[0]; $LeaseEnd = $first.end
  $o.lease = [ordered]@{ firstId = $first.id; firstEnd = $LeaseEnd; secLeft = $LeaseEnd - (NowS); forwardSec = (LeaseLeft); marginSec = [int]$lp.marginSec; revertSec = [int]$lp.revertSec; forwardMinSec = [int]$lp.forwardMinSec; startNodeSec = [int]$lp.startNodeSec }
  if ((LeaseLeft) -lt [int]$lp.forwardMinSec) { $why += "lease deadline: the first lease ends in $($LeaseEnd - (NowS)) s; this window needs >= $([int]$lp.forwardMinSec + [int]$lp.revertSec + [int]$lp.marginSec) s (forward + reserved return + margin)" } }
if (((Left) - $POST_WORST) -lt [int]$lp.forwardMinSec) { $why += 'the global bound left after the pins cannot hold the forward path and the post checks' }
if ($why.Count) { Final ('REFUSED: ' + ($why -join '; ')) $o }
if ($terminal) { $o.terminalReturn = 'TERMINAL RETURN: this rollback run reserves NO return window after itself; if it fails, no further return fits this lease cycle (root decides manually)' }
Log $o

# ---------------------------------------------------------------- stop (verbatim StopNode: identity, BeforeStop, bounded task request)
$Fwd = $true
$st = StopNode ([ordered]@{ pid = [int]$PRM.node.cmdPid; start = (Iso $PRM.node.cmdStart) }) ([ordered]@{ pid = [int]$PRM.node.agentPid; start = (Iso $PRM.node.agentStart) })
Log ([ordered]@{ step = 'stop-node'; decision = $st; nodeStopped = ($st -eq 'stopped'); stopProofAt = $script:LastStopProofAt })
if ($st -like 'REFUSED:*') { Final $st ([ordered]@{ leaseFirstEnd = $LeaseEnd; forwardLeft = (ForwardLeft) }) }
if ($st -eq 'identity changed; nothing stopped') { Final 'REFUSED: the node identity changed before the stop; nothing was stopped or written' ([ordered]@{}) }
if ($st -ne 'stopped') { Recovery "the node could not be proven stopped ($st); nothing was written or started" ([ordered]@{}) }
$phase = 'stopped'
$x = [ordered]@{ step = 'after-stop'; stopProofAt = $script:LastStopProofAt }
$ls = @(Listeners 9600 15); $x.listener9600 = @($ls | ForEach-Object { [int]$_.OwningProcess })
if ($ls.Count) { Recovery 'a 127.0.0.1:9600 listener remains after the node was proven stopped (a new agent could not own it); nothing was written; the node is NOT started' $x }
$uf = UnchangedFiles; if ($uf) { Recovery "a pinned unchanged file changed while the node was stopped ($uf); nothing was written; the node is NOT started" $x }
if ((PairNow) -ne 'from') { Recovery 'the modules changed while the node was stopped (not this run); nothing was written; the node is NOT started' $x }
Log $x

# ---------------------------------------------------------------- the pair, with the node proven stopped
$phase = 'swapping'
NeedForward
$sp = SwapPair $(if ($Mode -eq 'apply') { 'apply' } else { 'rollback' })
$x = [ordered]@{ step = 'pair'; pair = $sp.pair; why = $sp.why }
if ($sp.pair -eq 'unknown') { Recovery "$($sp.why); nothing more is written and the node is NOT started" $x }
$pairNow = PairNow; $x.pairNow = $pairNow
$expect = $(if ($sp.pair -eq 'to') { 'to' } else { 'from' })
if ($pairNow -ne $expect) { $script:FileMutationUnknown = $true; Recovery "the pair on disk is $pairNow, not the proven $expect; the node is NOT started" $x }
$uf = UnchangedFiles; if ($uf) { Recovery "a pinned unchanged file changed during the swap ($uf); the node is NOT started" $x }
Log $x

# ---------------------------------------------------------------- start on a CONSISTENT pair only
if ((ForwardLeft) -lt [int]$PRM.lease.startNodeSec) { Recovery "only $([math]::Floor((ForwardLeft))) s of forward time left (< lease.startNodeSec); the pair on disk is the consistent $pairNow pair; the node is NOT started by this run" ([ordered]@{ pair = $pairNow }) }
$phase = 'starting'
$nn = StartNode ([int]$PRM.lease.startNodeSec)
$Fwd = $false
$outcome = $(if ($sp.pair -eq 'to') { $(if ($Mode -eq 'apply') { 'the NEW pair' } else { 'the OLD pair (returned)' }) } else { $(if ($Mode -eq 'apply') { 'the OLD pair (the swap did not apply; proven writes undone)' } else { 'the NEW pair (the return did not apply; proven writes undone)' }) })
if (-not $nn) {
  Recovery "the Node task was started (response confirmed) on $outcome, but no new agent proved a completed lease pass inside lease.startNodeSec$(if ($script:StartRefusal) { " ($script:StartRefusal)" }); no retry, no stop, no swap by this run" ([ordered]@{ step = 'start-node'; launched = $script:NewLaunch; pair = $pairNow }) 'NOT_READY' }
Log ([ordered]@{ step = 'start-node'; agent = $nn.agent; cmd = $nn.cmd; pair = $pairNow; leaseLeft = (LeaseLeft) })

# ---------------------------------------------------------------- post
$phase = 'verified'
$post = [ordered]@{ step = 'post'; pair = $pairNow; agent = $nn.agent }
$post.identityUnchanged = Identity $post
$pp = @(Privacy); $post.privacyUnchanged = ($pp.Count -eq 1 -and $pp[0].pid -eq [int]$PRM.privacy.pid -and $pp[0].start -eq (Iso $PRM.privacy.start))
$post.schedulerUnchanged = Same ([int]$sch.pid) (Iso $sch.start) ([string]$sch.name) ([string]$sch.commandLike) 0
$post.pairUnchanged = ((PairNow) -eq $pairNow); $post.unchangedFiles = $(if (UnchangedFiles) { $false } else { $true })
$post.log = LogFrom $logOffset @('isolated domain retired', 'isolation spawned', 'is KEPT', 'not kept:')
$clean = $post.identityUnchanged -and $post.privacyUnchanged -and $post.schedulerUnchanged -and $post.pairUnchanged -and $post.unchangedFiles -and -not $post.log.error -and $post.log['isolated domain retired'] -eq 0
$name = $(if ($sp.pair -eq 'to') { $(if ($Mode -eq 'apply') { 'DONE' } else { 'ROLLED_BACK' }) } else { $(if ($Mode -eq 'apply') { 'SWAP_REFUSED_OLD_PAIR_RESTARTED' } else { 'RETURN_REFUSED_NEW_PAIR_RESTARTED' }) })
if ($terminal) { $post.terminalReturn = 'no return reserve remained after this terminal rollback' }
Final $(if ($clean) { "${name}: the node runs $outcome with a new agent proven ready; manager, privacy agent, scheduler, Hyper-V and manager VM sets, other tasks and pinned files unchanged" }
        else { "${name}_CHECK: the node runs $outcome with a new agent proven ready, but a post-check failed (see fields); root decides, nothing automatic" }) $post
