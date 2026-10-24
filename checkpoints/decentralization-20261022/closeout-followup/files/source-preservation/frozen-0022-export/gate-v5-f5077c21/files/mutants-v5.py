"""Mutation check of ONLY the v5 rule: each mutant weakens one v5 guard of verify-operational-v5.py; the tests named for it must FAIL.
Copies live BESIDE this folder (paths stay valid); an UNMUTATED control copy must pass first, else the run is invalid."""
import shutil, subprocess, sys
from pathlib import Path
A = Path(__file__).resolve().parent; F = 'verify-operational-v5.py'; SRC = (A/F).read_text()
T = 'tests.test_gate_v5.'
MUT = {   # name: (from, to, tests that must catch it)
 'two-resets': ("MAX_RESETS = 1", "MAX_RESETS = 2", ['GateV5.test_a_second_transient_fails']),
 'reset-keeps-window': ("                good_since = None; vouch_ats = set()", "                vouch_ats = set()", ['GateV5.test_one_transient_resets_and_needs_a_full_new_window_and_vouches']),
# NOT a mutant: dropping v5's own `vouch_ats = set()` on a reset is EQUIVALENT - v4's window start (`vouch_ats = {cur_vouch}`) already
# discards every earlier cycle; test_old_vouch_cycles_never_count_after_a_reset proves the property end to end instead.
 'transient-with-other-problem': ("            if not soft and len(result['resets']) < MAX_RESETS:", "            if len(result['resets']) < MAX_RESETS:", ['GateV5.test_a_transient_with_any_other_problem_fails', 'GateV5.test_real_http_errors_and_bad_payloads_still_fail_at_once']),
 'tls-is-transient': ("    if isinstance(inner, ssl.SSLError) or isinstance(e, ssl.SSLError): return False\n", "", ['Classify.test_transient_is_only_no_http_response_for_a_transport_reason']),
 'any-error-is-transient': ("    return isinstance(inner, TRANSIENT)", "    return True", ['Classify.test_transient_is_only_no_http_response_for_a_transport_reason', 'GateV5.test_real_http_errors_and_bad_payloads_still_fail_at_once']),
 'deadline-extends-on-reset': ("                good_since = None; vouch_ats = set()", "                good_since = None; vouch_ats = set(); t0 = time.monotonic()", ['GateV5.test_the_deadline_never_extends']),
 'reset-not-recorded': ("                result['resets'].append(", "                (lambda *x: None)(", ['GateV5.test_a_second_transient_fails']),
}
def run(name, src, tests):
    d = A.parent / f'{A.name}.mut-{name}'
    if d.exists(): shutil.rmtree(d)
    shutil.copytree(A, d, ignore=shutil.ignore_patterns('.git', 'logs', '__pycache__', '*.mut-*'))
    (d/F).write_text(src)
    r = subprocess.run([sys.executable, '-m', 'unittest', *[T + t for t in tests]], cwd=d, capture_output=True, text=True, timeout=600)
    shutil.rmtree(d); return r
allt = sorted({t for _, _, ts in MUT.values() for t in ts})
c = run('control', SRC, allt)
if c.returncode != 0: print('CONTROL FAILED: the run is invalid\n' + c.stderr[-2000:]); sys.exit(2)
print('control (unmutated copy) passes', len(allt), 'tests')
bad = 0
for name, (a, b, tests) in MUT.items():
    assert SRC.count(a) == 1, (name, a[:70])
    r = run(name, SRC.replace(a, b), tests); killed = r.returncode != 0; bad += not killed
    print(('KILLED  ' if killed else 'SURVIVED'), name, flush=True)
print(f'mutants {len(MUT)} survived {bad}'); sys.exit(1 if bad else 0)
