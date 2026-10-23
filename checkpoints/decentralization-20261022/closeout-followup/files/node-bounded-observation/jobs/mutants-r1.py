#!/usr/bin/env python3
"""Mutants of the bounded-observation semantics. One exact replacement each; the mutant must PARSE; only its targeted tests run."""
import hashlib, os, pathlib, subprocess, sys
H = pathlib.Path(__file__).resolve().parent.parent; P = os.environ['PWSH']; SRC = (H / 'helper/node-pair-observe.ps1').read_text()
M = [
 ('B1 the 610 floor back', '$MIN_OBSERVE = 60;', '$MIN_OBSERVE = 610;', ['test_the_observation_floor_is_60_s_and_needs_no_completed_pass_duration']),
 ('B2 post not reserved', '[int]$lp.startNodeSec + $POST_WORST } else', '[int]$lp.startNodeSec } else', ['test_budget_params_refused_before_anything']),
 ('B3 a late read is evaluated', "$h = HostState (($lim - (Get-Date)).TotalSeconds); if ((Get-Date) -ge $lim) { return 'not-yet' }\n      $s = ServingRows",
  "$h = HostState (($lim - (Get-Date)).TotalSeconds)\n      $s = ServingRows", ['test_a_read_completing_after_the_deadline_never_counts']),
 ('B4 bound expiry reported as DONE', 'Final "${name}_NOT_SERVING_CHECK:', 'Final "${name}:', ['test_m1_only_ends_at_the_bound_as_not_serving_and_before_rollbackBy_at_the_exact_budget']),
 ('B5 deadline means serving', "$o = OwnedNow $agent $lim; if ($null -eq $o) { return 'not-yet' }; if (-not $o) { return 'lost' }\n      if (-not (PollRoom $lim))",
  "$o = OwnedNow $agent $lim; if ($null -eq $o) { return 'serving' }; if (-not $o) { return 'lost' }\n      if (-not (PollRoom $lim))", ['test_m1_only_ends_at_the_bound_as_not_serving_and_before_rollbackBy_at_the_exact_budget']),
]
out = H / 'tmp/mutants'; out.mkdir(parents=True, exist_ok=True); res = []
for name, a, b, tests in M:
    if SRC.count(a) != 1: res.append((name, f'INVALID: pattern count {SRC.count(a)}')); continue
    mf = out / (hashlib.sha256(name.encode()).hexdigest()[:8] + '.ps1'); mf.write_text(SRC.replace(a, b))
    parse = subprocess.run([P, '-NoProfile', '-NonInteractive', '-Command', "$t=$null;$e=$null;[void][Management.Automation.Language.Parser]::ParseFile('" + str(mf) + "',[ref]$t,[ref]$e);if($e.Count){$e|%{$_.Message};exit 9}"], capture_output=True, text=True, timeout=60)
    if parse.returncode: res.append((name, 'INVALID: does not parse ' + parse.stdout[-200:])); continue
    c = subprocess.run([sys.executable, '-u', str(H / 'tools/observe-test.py')] + [f'Activate.{x}' for x in tests], env=dict(os.environ, OBS_SCRIPT=str(mf)), capture_output=True, text=True, timeout=400)
    res.append((name, 'KILLED' if c.returncode else 'SURVIVED'))
    if not c.returncode: print(c.stderr[-1500:])
for n, r in res: print(f'{r:12s} {n}')
