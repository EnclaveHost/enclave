from pathlib import Path
import shutil
r=Path(__file__).resolve().parent;src=r.parent/'node-http-budget-20261022'
for name in ['tools/cutover-mock.ps1','tools/cutover-mock-test.py','tools/preparation-test.py','run-tests.sh']:
 shutil.copy2(src/name,r/name)
s=(src/'helper/node-hold-cutover.ps1').read_text()
s=s.replace('function StopNode(', (r/'task-command.ps1').read_text()+'\nfunction StopNode(',1)
# Only replace the production call sites outside the wrapper itself.
s=s.replace("  Stop-ScheduledTask -TaskPath '\\Enclave\\' -TaskName 'Node'\n  if (-not (WaitNodeGone", "  NodeTask 'Stop'\n  if (-not (WaitNodeGone",1)
s=s.replace("  Start-ScheduledTask -TaskPath '\\Enclave\\' -TaskName 'Node'\n  while (-not $n", "  NodeTask 'Start' (($lim - (Get-Date)).TotalSeconds)\n  while (-not $n",1)
s=s.replace("  $x = [ordered]@{ phase = $phase; error = $_.Exception.Message }", "  $x = [ordered]@{ phase = $phase; error = $_.Exception.Message }\n  if ($script:TaskMutationUnknown) { Recovery 'task request outcome unknown; no automatic retry or config rollback; inspect actual task/process state' $x }",1)
s=s.replace('function Recovery($what, $x) { $x.recovery = $what;', 'function Recovery($what, $x) { $x.taskCommand = $script:LastTaskCommand; $x.recovery = $what;',1)
(r/'helper/node-hold-cutover.ps1').write_text(s)
print('Composed bounded task requests with explicit unknown-outcome handling.')
