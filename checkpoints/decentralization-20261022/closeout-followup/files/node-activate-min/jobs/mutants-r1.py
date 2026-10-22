#!/usr/bin/env python3
"""Mutants of the NEW logic of node-pair-activate.ps1. Each: exactly one textual replacement, the mutant must PARSE (a syntax
error is not a kill), then only the tests that target it run; killed = those tests fail at the mutant."""
import hashlib, os, pathlib, subprocess, sys
H = pathlib.Path(__file__).resolve().parent.parent; P = os.environ['PWSH']; SRC = (H / 'helper/node-pair-activate.ps1').read_text()
M = [
 ('N1 row of another pass accepted', "elseif ([int64]$c.sequence -ne [int64]$r.sequence) { $why = 'a row of another pass' }", "elseif ($false) { $why = 'a row of another pass' }", ['test_rows_that_do_not_prove_serving_are_never_accepted']),
 ('N2 any status accepted', "if ([string]$c.status -ne 'ready') { $why = 'status ' + [string]$c.status }", "if ($false) { $why = 'status ' + [string]$c.status }", ['test_restarted_but_not_serving_is_a_check_with_the_rows_and_rollbackBy']),
 ('N3 lost listener treated as not-yet', "$o = OwnedNow $agent $lim; if ($null -eq $o) { return 'not-yet' }; if (-not $o) { return 'lost' }\n      if (-not (PollRoom $lim))", "$o = OwnedNow $agent $lim; if ($null -eq $o) { return 'not-yet' }; if (-not $o) { return 'not-yet' }\n      if (-not (PollRoom $lim))", ['test_a_listener_lost_after_m1_is_not_ready']),
 ('N4 a pass before the agent counts for M1', "return [bool]([int64]$r.sequence -gt 0 -and [int64]$r.startedAt -ge $sinceMs -and", "return [bool]([int64]$r.sequence -gt 0 -and [int64]$r.startedAt -ge 0 -and", ['test_no_m1_ends_not_ready_without_retry']),
 ('N5 reserve without the restart', "[int]$lp.revertSec -lt [int]$lp.returnPinsSec + (RestartMin))", "[int]$lp.revertSec -lt [int]$lp.returnPinsSec)", ['test_budget_params_refused_before_anything']),
 ('N6 rollback may reserve', "if ($Mode -eq 'rollback' -and [int]$lp.revertSec -ne 0)", "if ($Mode -eq 'rollback' -and [int]$lp.revertSec -lt 0)", ['test_rollback_reserves_nothing_after_itself']),
 ('N7 margin ignored', "elseif ([double]$c.leaseUntil -le (NowS) + [int]$PRM.lease.marginSec) { $why = 'lease within the margin' }", "elseif ($false) { $why = 'lease within the margin' }", ['test_a_lease_inside_the_margin_is_not_serving']),
 ('N8 not-yet reported as DONE', 'Final "${name}_NOT_SERVING_CHECK:', 'Final "${name}:', ['test_restarted_but_not_serving_is_a_check_with_the_rows_and_rollbackBy']),
 ('N9 serving accepted only on a completed pass', "if ($s.ok) { $o = OwnedNow", "if ($s.ok -and -not $s.inFlight) { $o = OwnedNow", ['test_apply_restarts_then_serves_with_the_pass_still_in_flight']),
 ('N10 BeforeStop drops the lease forward check', "if ((LeaseLeft) -lt [int]$PRM.lease.forwardMinSec -or ((Left) - $POST_WORST) -lt (RestartMin))", "if (((Left) - $POST_WORST) -lt (RestartMin))", ['test_a_lease_shrinking_before_the_stop_refuses_at_beforestop']),
 ('N11 another runner accepted', "elseif ([string]$c.runner -ne [string]$PRM.runner) { $why = 'another runner' }", "elseif ($false) { $why = 'another runner' }", ['test_rows_that_do_not_prove_serving_are_never_accepted']),
]
out = H / 'tmp/mutants'; out.mkdir(parents=True, exist_ok=True); res = []
for name, a, b, tests in M:
    if SRC.count(a) != 1: res.append((name, f'INVALID: pattern count {SRC.count(a)}')); continue
    mf = out / (hashlib.sha256(name.encode()).hexdigest()[:8] + '.ps1'); mf.write_text(SRC.replace(a, b))
    parse = subprocess.run([P, '-NoProfile', '-NonInteractive', '-Command', "$t=$null;$e=$null;[void][Management.Automation.Language.Parser]::ParseFile('" + str(mf) + "',[ref]$t,[ref]$e);if($e.Count){$e|%{$_.Message};exit 9}"], capture_output=True, text=True, timeout=60)
    if parse.returncode: res.append((name, 'INVALID: does not parse ' + parse.stdout[-200:])); continue
    if tests is None: res.append((name, 'SURVIVES BY DESIGN? see note')); continue
    c = subprocess.run([sys.executable, '-u', str(H / 'tools/activate-test.py')] + [f'Activate.{x}' for x in tests], env=dict(os.environ, ACT_SCRIPT=str(mf)), capture_output=True, text=True, timeout=400)
    res.append((name, 'KILLED' if c.returncode else 'SURVIVED'))
    if not c.returncode: print(c.stderr[-1500:])
for n, r in res: print(f'{r:12s} {n}')
