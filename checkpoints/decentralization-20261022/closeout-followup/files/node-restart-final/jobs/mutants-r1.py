#!/usr/bin/env python3
"""One helper mutant at a time (restored from a byte copy on exit); each must make its targeted pair-test scenarios FAIL."""
import os, shutil, subprocess, sys, time
H = '/home/steven/Documents/Codex/2026-10-18/wo/work/resume-after-checkpoint-20261022/node-restart-final'
F = os.path.join(H, 'helper/node-pair-restart.ps1'); B = F + '.mutant-orig'
M = [
 ('M1 a timed-out swap child counted as conclusively unchanged', 'test_a_hung_swap_child',
  "elseif ($c.exited -and -not $c.timedOut -and $now -eq $before", "elseif ($c.exited -and $now -eq $before"),
 ('M2 proven earlier steps not undone', 'test_second_file_refused',
  "    for ($k = $done.Count - 1; $k -ge 0; $k--) {", "    for ($k = -1; $k -ge 0; $k--) {"),
 ('M2b no undo AND no consistent-pair check before the start', 'test_second_file_refused',
  [("    for ($k = $done.Count - 1; $k -ge 0; $k--) {", "    for ($k = -1; $k -ge 0; $k--) {"), ("if ($pairNow -ne $expect) {", "if ($false) {")]),
 ('M3 the new launcher parent not checked', 'test_a_launcher_of_another_parent',
  "if (-not $row -or (Utc $row) -ne $c.start -or [int]$row.ParentProcessId -ne [int]$PRM.scheduler.pid) {", "if (-not $row -or (Utc $row) -ne $c.start) {"),
 ('M4 a stale 9600 listener ignored', 'test_stale_9600',
  "if ($ls.Count) { Recovery", "if ($false) { Recovery"),
 ('M5 the measured first-pass floor removed', 'test_budget_params_refused',
  "if ([int]$lp.startNodeSec -lt $MIN_START_NODE)", "if ($false)"),
 ('M6 the updater horizon through the reserve removed', 'test_updater_and_lease_refusals',
  "$uh = UpdateHorizon $uv; if ($uh) { $why += $uh }", "$uh = $null"),
 ('M7 an unknown swap still starts the node', 'test_acl_not_restored',
  "if ($sp.pair -eq 'unknown') { Recovery", "if ($false) { Recovery"),
 ('M8 the stopped identities may come back as the new agent', 'test_a_reused_pid_with_a_new_start',
  "if (($c.pid -eq [int]$PRM.node.cmdPid -and $c.start -eq (Iso $PRM.node.cmdStart)) -or ($a.pid -eq [int]$PRM.node.agentPid -and $a.start -eq (Iso $PRM.node.agentStart))) {",
  "if ($a.pid -eq [int]$PRM.node.agentPid) {"),
]
shutil.copyfile(F, B); bad = 0
try:
  for m in M:
    name, k = m[0], m[1]; edits = m[2] if isinstance(m[2], list) else [(m[2], m[3])]
    src = open(B).read()
    for a, b in edits:
      if src.count(a) != 1: print(f'{name}: pattern not found once'); sys.exit(2)
      src = src.replace(a, b)
    open(F, 'w').write(src); t0 = time.time()
    p = subprocess.run(['timeout', '-k', '5', '200', 'python3', '-u', os.path.join(H, 'tools/pair-test.py'), '-k', k], cwd=H, capture_output=True, text=True)
    shutil.copyfile(B, F)
    killed = p.returncode != 0; bad += 0 if killed else 1
    print(f"{'KILLED' if killed else 'SURVIVED'} {name} (-k {k}, exit {p.returncode}, {round(time.time() - t0)} s)", flush=True)
  print('MUTANTS', 'ALL KILLED' if not bad else f'{bad} SURVIVED'); sys.exit(1 if bad else 0)
finally:
  shutil.copyfile(B, F); os.remove(B)
  subprocess.run('rm -rf tmp/pair-*', shell=True, cwd=H)
