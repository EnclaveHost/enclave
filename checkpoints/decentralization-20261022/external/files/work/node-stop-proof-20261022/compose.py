from pathlib import Path
import shutil
r=Path(__file__).resolve().parent;src=r.parent/'node-task-budget-20261022'
for name in ['tools/cutover-mock.ps1','tools/cutover-mock-test.py','tools/preparation-test.py','run-tests.sh']:
 shutil.copy2(src/name,r/name)
s=(src/'helper/node-hold-cutover.ps1').read_text()
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
s=s.replace("decision = $st; nodeStopped = (NodeStopped)", "decision = $st; nodeStopped = ($st -eq 'stopped'); stopProofAt = $script:LastStopProofAt",1)
s=s.replace("if ($st -ne 'stopped' -or -not (NodeStopped))", "if ($st -ne 'stopped')",1)
# Preserve task uncertainty evidence if the fallback itself fails after a task request.
s=s.replace('} catch { $x.final = "RECOVERY_REQUIRED: the fallback itself failed', '} catch { $x.taskCommand = $script:LastTaskCommand; $x.final = "RECOVERY_REQUIRED: the fallback itself failed',1)
(r/'helper/node-hold-cutover.ps1').write_text(s)
print('Composed complete stop proof; redundant immediate reads removed, fresh pre-start proof retained.')
