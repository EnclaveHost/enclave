#!/usr/bin/env python3
"""One helper mutant at a time (restored from a byte copy on exit); each must make its targeted pair-test scenarios FAIL."""
import os, shutil, subprocess, sys, time
H = '/home/steven/Documents/Codex/2026-10-18/wo/work/resume-after-checkpoint-20261022/node-restart-final'
F = os.path.join(H, 'helper/node-pair-restart.ps1'); B = F + '.mutant-orig'
M = [
 ('M6b the updater horizon removed at the pins AND before the stop', 'test_updater_and_lease_refusals',
  [("$uh = UpdateHorizon $uv; if ($uh) { $why += $uh }", "$uh = $null"), ("    $uh = UpdateHorizon $uv; if ($uh) { return $uh + '; nothing stopped' }\n", "")]),
 ('M7b an unknown swap AND a mixed pair on disk no longer stop the start', 'test_acl_not_restored',
  [("if ($sp.pair -eq 'unknown') { Recovery", "if ($false) { Recovery"), ("if ($pairNow -ne $expect) {", "if ($false) {")]),
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
