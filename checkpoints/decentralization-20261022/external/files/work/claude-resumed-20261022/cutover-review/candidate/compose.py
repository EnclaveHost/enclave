from pathlib import Path
import hashlib, shutil, sys
# Usage: python3 compose.py [TASK_BUDGET_DIR]   (default: ../../../node-task-budget-20261022 relative to this file's directory)
r=Path(__file__).resolve().parent
src=Path(sys.argv[1]).resolve() if len(sys.argv)>1 else r.parents[2]/'node-task-budget-20261022'
SRC_SHA='446821562d4f6e88e629148a3b2a31abca26fcffee22b859397052106cdff867'   # node-task-budget helper (root, natively task-tested)
STOP_PROOF_SHA='d88bab632e6ae0f5f7208f82a1c8ec0ab209ed4f5a5b82c45de38731ccce466f'   # node-stop-proof-20261022 delivered helper
sha=lambda t: hashlib.sha256(t.encode()).hexdigest()
s=(src/'helper/node-hold-cutover.ps1').read_text()
assert sha(s)==SRC_SHA, 'source helper is not the pinned task-budget candidate'

# ---------------------------------------------------------------- stage 1: node-stop-proof-20261022 exactly (its compose.py + the floor550 edit)
a="  if (-not (Same $cmd.pid $cmd.start 'cmd.exe' $RUN_PAT 0) -or -not (Same $agent.pid $agent.start 'node.exe' $AGENT_PAT $cmd.pid)) { return 'identity changed; nothing stopped' }"
b="""  # One fresh snapshot checks both identities together and refuses duplicate launchers/agents.
  $script:LastStopProofAt = $null
  $p = NodeProcs
  if ($p.cmd.Count -ne 1 -or $p.agent.Count -ne 1 -or $p.cmd[0].pid -ne $cmd.pid -or $p.cmd[0].start -ne $cmd.start -or
      $p.agent[0].pid -ne $agent.pid -or $p.agent[0].start -ne $agent.start -or $p.agent[0].parent -ne $cmd.pid) { return 'identity changed; nothing stopped' }"""
assert a in s;s=s.replace(a,b,1)
a="  if (@((NodeProcs).agent).Count -ne 0) { return 'another node agent is running' }\n  return 'stopped'"
b="""  # A stopped result itself proves BOTH process sets empty; callers consume this proof immediately.
  $p = NodeProcs
  if ($p.cmd.Count -ne 0 -or $p.agent.Count -ne 0) { return 'node processes remain after the stop' }
  $script:LastStopProofAt = Now
  return 'stopped'"""
assert a in s;s=s.replace(a,b,1)
a="""  $q = NodeProcs
  if ($q.cmd.Count -or $q.agent.Count) {
    $x.stop = $(if ($q.cmd.Count -eq 1 -and $q.agent.Count -eq 1 -and $q.agent[0].parent -eq $q.cmd[0].pid) { StopNode $q.cmd[0] $q.agent[0] } else { 'the node processes are not one identifiable cmd+agent' }) }
  if (-not (NodeStopped)) { Recovery "the node could not be proven stopped ($($x.stop)); NO config was touched by the revert" $x }"""
b="""  $q = NodeProcs
  $stopped = ($q.cmd.Count -eq 0 -and $q.agent.Count -eq 0)
  if ($stopped) { $script:LastStopProofAt = Now }
  else {
    $x.stop = $(if ($q.cmd.Count -eq 1 -and $q.agent.Count -eq 1 -and $q.agent[0].parent -eq $q.cmd[0].pid) { StopNode $q.cmd[0] $q.agent[0] } else { 'the node processes are not one identifiable cmd+agent' })
    $stopped = $x.stop -eq 'stopped'
  }
  if (-not $stopped) { Recovery "the node could not be proven stopped ($($x.stop)); NO config was touched by the revert" $x }
  $x.stopProofAt = $script:LastStopProofAt"""
assert a in s;s=s.replace(a,b,1)
for a,b in (("decision = $st; nodeStopped = (NodeStopped)", "decision = $st; nodeStopped = ($st -eq 'stopped'); stopProofAt = $script:LastStopProofAt"),
            ("if ($st -ne 'stopped' -or -not (NodeStopped))", "if ($st -ne 'stopped')"),
            ('} catch { $x.final = "RECOVERY_REQUIRED: the fallback itself failed', '} catch { $x.taskCommand = $script:LastTaskCommand; $x.final = "RECOVERY_REQUIRED: the fallback itself failed'),
            # the floor550 edit made directly in node-stop-proof-20261022 after its compose.py ran
            ("# The 330-second parameter floor is necessary, not a native timing proof. DO NOT ACTIVATE this revision on mocks alone.",
             "# The 550-second recovery floor accounts for bounded calls plus a local-operation allowance; OS failures may still require manual recovery. DO NOT ACTIVATE this revision on mocks alone."),
            ("""  # This is only a NECESSARY floor: 90+90+150 are the explicit recovery waits alone.
  # Native stop/query/file overhead and renewal readiness STILL require separate proof before activation.
  if ($lp -and [int]$lp.revertSec -lt (90 + 90 + 150)) { $why += 'revert budget is shorter than its explicit 330-second waits (before native overhead)' }""",
             """  # Recoverable path: initial snapshot15 + StopNode135 + privacy snapshot15 + restart90 + plain status90
  # + final stopped snapshot15 + node readiness150 =510; add40 for local file/ACL/kill/log work and polling.
  # An uncertain task request is explicitly manual recovery, never counted as a successful rollback.
  if ($lp -and [int]$lp.revertSec -lt 550) { $why += 'revert budget is shorter than the 550-second bounded-path allowance' }""")):
 assert s.count(a)==1,a[:60];s=s.replace(a,b,1)
assert sha(s)==STOP_PROOF_SHA, 'stage 1 does not reproduce node-stop-proof-20261022 exactly'

# ---------------------------------------------------------------- stage 2: cutover-review fixes (Claude, 2026-10-22)
def rep(a,b):
 global s
 assert s.count(a)==1,('anchor not unique/present',a[:80]);s=s.replace(a,b,1)
# R1: a poll whose phase can no longer fit one bounded reader (2.5 s incl. cleanup) ends NOT PROVEN instead of throwing from
# Query; on Windows the throw made WaitNodeGone's false (and so the forced agent kill) unreachable and re-entered the trap.
rep("""function Utc($p) {""",
"""# A poll launches another reader only while its phase still fits one (2.5 s incl. cleanup); otherwise the phase ends NOT
# PROVEN (false/null). Running out of phase time is an outcome, not an exception that would re-enter the trap.
function PollRoom($lim) { (Lim (($lim - (Get-Date)).TotalSeconds)) -ge 2.5 }
function Utc($p) {""")
rep("""  while ((Get-Date) -lt $lim) {
    $same = Same""","""  while ((Get-Date) -lt $lim) {
    if (-not (PollRoom $lim)) { return $false }
    $same = Same""")
rep("""  while (-not $n -and (Get-Date) -lt $lim) {
    $q = NodeProcs""","""  while (-not $n -and (Get-Date) -lt $lim) {
    if (-not (PollRoom $lim)) { return $null }
    $q = NodeProcs""")
rep("""  $lim = (Get-Date).AddSeconds($budget)
  $pa = @(Privacy""","""  $lim = (Get-Date).AddSeconds($budget)
  if (-not (PollRoom $lim)) { return $null }
  $pa = @(Privacy""")
rep("""    Start-Sleep -Seconds 2; if ((Get-Date) -ge $lim) { break }""","""    Start-Sleep -Seconds 2; if ((Get-Date) -ge $lim -or -not (PollRoom $lim)) { break }""")
# R4: readiness. The node's lease pass runs every 30 s (host.mjs TICK_MS) and LeaseReady demands completedAt < 5 s old, but each
# attempt paid a ~10 s native listener query before its single host-state read. Prove ownership once, poll the host state
# cheaply, then prove ownership AGAIN: the ready answer is bracketed by two ownership proofs inside the same phase deadline.
rep("""function AgentUp($agent, [double]$limitSec = 15) {
  # Listener ownership and HTTP response share ONE phase deadline; neither gets a fresh budget after the other.
  $lim = (Get-Date).AddSeconds((Lim $limitSec))
  try {
    $listeners = @(Listeners 9600 (($lim - (Get-Date)).TotalSeconds))
    if ((Get-Date) -ge $lim -or $listeners.Count -ne 1 -or [int]$listeners[0].OwningProcess -ne [int]$agent.pid) { return $false }
    $h = HostState (($lim - (Get-Date)).TotalSeconds)
    if ((Get-Date) -ge $lim) { return $false }
    return (LeaseReady $h (IsoMs $agent.start))
  } catch { if ($script:QueryCleanupFailed) { throw }; return $false }
}""","""function OwnsAgentPort($agent, $lim) {
  if (-not (PollRoom $lim)) { return $false }
  $listeners = @(Listeners 9600 (($lim - (Get-Date)).TotalSeconds))
  return [bool]((Get-Date) -lt $lim -and $listeners.Count -eq 1 -and [int]$listeners[0].OwningProcess -eq [int]$agent.pid)
}
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
}""")
# R3: Recovery runs inside the trap too; a failing reader there ended the script with NO final journal line.
rep("""function Recovery($what, $x) { $x.taskCommand = $script:LastTaskCommand; $x.recovery = $what; $x.nodeStopped = (NodeStopped); $x.localSha = (Sha $LOCAL); $x.cfgSha = (Sha $CFG)""",
"""function Recovery($what, $x) { $x.taskCommand = $script:LastTaskCommand; $x.recovery = $what
  # this also runs inside the trap: a failing read is recorded, never allowed to suppress the final journal line
  $x.nodeStopped = $(try { NodeStopped } catch { 'unknown: ' + $_.Exception.Message })
  $x.localSha = $(try { Sha $LOCAL } catch { 'unreadable' }); $x.cfgSha = $(try { Sha $CFG } catch { 'unreadable' })""")
# R2: ONE revert pass. A throw inside a Revert called from the main path re-entered the trap, which ran a SECOND full revert
# outside the reserved revertSec (stopping a node the first pass started, killing the privacy agent again).
rep("""  $script:Fwd = $false                                  # the revert's own waits are never cut by the lease deadline
""","""  $script:Fwd = $false                                  # the revert's own waits are never cut by the lease deadline
  $script:RevertState = 'started'                       # the trap never starts a second revert (its budget is spent once)
""")
rep("""  if (-not $nn) { Recovery 'both configs ARE restored and the network does not enforce, but the started node did not answer' $x }
  return $x }""","""  if (-not $nn) { Recovery 'both configs ARE restored and the network does not enforce, but the started node did not answer' $x }
  $script:RevertState = 'complete'
  return $x }""")
rep("""  if ($script:TaskMutationUnknown) { Recovery 'task request outcome unknown; no automatic retry or config rollback; inspect actual task/process state' $x }
""","""  if ($script:TaskMutationUnknown) { Recovery 'task request outcome unknown; no automatic retry or config rollback; inspect actual task/process state' $x }
  if ($script:RevertState -eq 'complete') { $x.final = "ROLLED_BACK_CHECK: the revert completed (configs restored, network not enforcing, node answered) but a later check failed ($($x.error)); no second revert; root decides"; Log $x; exit 1 }
  if ($script:RevertState) { Recovery "the revert itself failed ($($x.error)); no second automatic revert; inspect the actual node, privacy agent and config state" $x }
""")
rep("""} catch { $x.taskCommand = $script:LastTaskCommand; $x.final = "RECOVERY_REQUIRED: the fallback itself failed ($($_.Exception.Message)); see the steps"; Log $x; exit 1 } }""",
"""} catch { $x.taskCommand = $script:LastTaskCommand
    $x.final = $(if ($script:RevertState -eq 'complete') { "ROLLED_BACK_AFTER_CRASH_CHECK: the revert completed, but a later check failed ($($_.Exception.Message)); root decides" }
                 else { "RECOVERY_REQUIRED: the fallback itself failed ($($_.Exception.Message)); see the steps" }); Log $x; exit 1 } }""")
rep("""  # An uncertain task request is explicitly manual recovery, never counted as a successful rollback.
""","""  # An uncertain task request is explicitly manual recovery, never counted as a successful rollback. ONE revert pass only:
  # a failure inside it is RECOVERY_REQUIRED (never a second pass), and a phase that cannot fit a reader ends NOT PROVEN.
""")
rep("# ROOT revision 2026-10-22: config rendering precedes the stop;","# ROOT revision 2026-10-22 + cutover-review (one revert pass, poll room, bracketed readiness): config rendering precedes the stop;")
(r/'helper').mkdir(exist_ok=True)
(r/'helper/node-hold-cutover.ps1').write_text(s)
print('stage1', STOP_PROOF_SHA[:8], 'reproduced; stage2 review helper', sha(s))
