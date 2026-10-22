#!/usr/bin/env python3
"""One helper mutant at a time (restored from a byte copy on exit); each must make its targeted pair-test scenarios FAIL."""
import os, shutil, subprocess, sys, time
H = '/home/steven/Documents/Codex/2026-10-18/wo/work/resume-after-checkpoint-20261022/node-restart-final'
F = os.path.join(H, 'helper/node-pair-restart.ps1'); B = F + '.mutant-orig'
M = [
 ('N1 terminal-return accepted for apply', 'test_apply_never_takes_a_zero_reserve',
  "elseif ($rk -eq 'terminal-return' -and $Mode -ne 'rollback') {", "elseif ($false) {"),
 ('N2 revertSec 0 accepted without the explicit terminal return', 'test_rollback_with_zero_reserve_needs',
  "([int]$lp.revertSec -eq 0 -and -not $terminal)", "($false)"),
 ('N3 the exact running set not checked at the pins', 'test_the_running_set_must_be_exactly_expectedIds_at_the_pins',
  "if ($rs) { $why += $rs } }", "} }"),
 ('N4 the exact running set not checked before the stop', 'test_the_running_set_is_checked_again',
  [("    $rs = RunningSetDiff $h; if ($rs) { return \"$rs; nothing stopped\" }\n", "")]),
 ('N5 the full return without the return pins allowance', 'test_full_return_needs_forward_plus_return_pins',
  "([int]$lp.returnPinsSec -le 0 -or [int]$lp.revertSec -lt [int]$lp.forwardMinSec + [int]$lp.returnPinsSec)", "([int]$lp.revertSec -lt [int]$lp.forwardMinSec)"),
 ('N6 the terminal return without its own forward window', 'test_terminal_return_needs_its_own_full_forward_window',
  "if ((LeaseLeft) -lt [int]$lp.forwardMinSec) { $why += \"lease deadline", "if ($false) { $why += \"lease deadline"),
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
