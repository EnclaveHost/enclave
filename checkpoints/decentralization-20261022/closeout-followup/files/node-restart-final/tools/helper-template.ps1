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
# <<verbatim:Iso>>
# <<verbatim:Left>>
# <<verbatim:NowS>>
# <<verbatim:LeaseLeft>>
# MODIFIED (no revert inside this run): the forward path keeps the post-check time of the global bound, and LeaseLeft already
# reserves root's rollback (lease.revertSec) before the first lease ends
function ForwardLeft { [math]::Min(((Left) - $POST_WORST), (LeaseLeft)) }
# <<verbatim:Lim>>
# <<verbatim:NeedForward>>
# <<verbatim:UpdateDecision>>
# <<verbatim:UpdateState>>
# <<verbatim:Now>>
# <<verbatim:NowMs>>
# <<verbatim:IsoMs>>
# <<verbatim:Sha>>
# <<verbatim:Log>>
# <<verbatim:Final>>
# <<verbatim:Invoke-BoundedQuery>>
# <<verbatim:Query>>
# <<verbatim:PollRoom>>
# <<verbatim:Utc>>
# <<verbatim:ProcessRows>>
# <<verbatim:ById>>
# <<verbatim:Same>>
# <<verbatim:NodeProcs>>
# <<verbatim:Privacy>>
# <<verbatim:Listeners>>
# <<verbatim:Manager>>
# <<verbatim:HostState>>
# <<verbatim:Vms>>
# <<verbatim:Known>>
# <<verbatim:ReadinessNumber>>
# <<verbatim:LeaseReady>>
# <<verbatim:OwnsAgentPort>>
# <<verbatim:AgentUp>>
# <<verbatim:LogFrom>>
# <<verbatim:WaitNodeGone>>
# <<verbatim:Invoke-TaskCommand>>
# <<verbatim:NodeTask>>
# <<verbatim:StopNode>>
# <<verbatim:NodeStopped>>
# <<verbatim:Identity>>

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
