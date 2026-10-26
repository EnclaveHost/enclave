#!/usr/bin/env python3
"""status.py OUTDIR VARIANTS (r3; guest at the end of diag.sh AND host on whatever partial out/ was fetched). Derives a TRUTHFUL
diagnostic status from the files actually present. A phase is `complete` ONLY if its runner rc is 0 AND its probe file says
complete:true AND carries what that phase is for (A: the EL's finalized block and every step timed; B: Helios's finalized block, all four
calls timed, and the relay log). Anything else (aborted probe, kill/timeout, Helios never ready, missing files) is `incomplete: <why>`.
Invariant violations (production PIDs changed, own listener left bound, PIDs never re-checked) are reported separately.
Observations (timings, timeouts, RPC errors inside the probes) are NEVER pass/fail: this is a diagnostic, not a capture, readiness or
finality verdict, and no positive verdict field is ever written. Exit 30 = invariant violation, 10 = incomplete, 0 = all requested
phases complete and invariants hold."""
import json, pathlib, sys
o = pathlib.Path(sys.argv[1]); V = sys.argv[2].split()
def lines(p):
    return (o / p).read_text().splitlines() if (o / p).exists() else []
def js(p):
    try: return json.loads((o / p).read_text())
    except (OSError, ValueError): return None
def timed(probe):
    return bool(probe.get('steps')) and all(isinstance(s.get('ms'), int) for s in probe['steps'])
rc = dict(l.split(None, 1) for l in lines('phase-rc.txt') if ' ' in l)
ph = {}
a = js('el-probe.json')
if rc.get('A') != '0':
    ph['A'] = f"incomplete: runner rc={rc.get('A', 'missing')}"
elif not a:
    ph['A'] = 'incomplete: el-probe.json missing or unreadable'
elif a.get('complete') is not True or not a.get('finalized') or not timed(a):
    ph['A'] = f"incomplete: {a.get('incompleteReason') or 'probe did not complete every step'}"
else:
    ph['A'] = 'complete'
for q in ('100', '400'):
    k = 'B' + q
    if q not in V:
        ph[k] = 'not-requested'; continue
    h = js(f'helios-probe-{q}.json')
    if rc.get(k) != '0':
        ph[k] = f"incomplete: runner rc={rc.get(k, 'missing')}"
    elif not h:
        ph[k] = 'incomplete: helios probe file missing or unreadable'
    elif h.get('complete') is not True or not h.get('finalized') or len(h.get('steps', [])) != 4 or not timed(h):
        ph[k] = f"incomplete: {h.get('incompleteReason') or 'Helios calls not all run'}"
    elif not (o / f'el-requests-{q}.jsonl').exists():
        ph[k] = 'incomplete: relay log missing (Helios EL call flow not observed)'
    else:
        ph[k] = 'complete'
inv = lines('invariants.txt')
if not any((o / p).exists() for p in ('pids-after.txt', 'pids-after-cleanup.txt')):
    inv.append('production PIDs were never re-checked (unknown)')
st = {'format': 'enclave-guest-call-diagnostic-status/v3', 'kind': 'diagnostic observations only; NOT a capture, readiness or finality verdict',
      'variants': V, 'phases': ph, 'invariants': {'ok': not inv, 'violations': inv},
      'complete': all(v in ('complete', 'not-requested') for v in ph.values())}
(o / 'status.json').write_text(json.dumps(st, indent=1) + '\n'); print(json.dumps(st))
sys.exit(30 if inv else 0 if st['complete'] else 10)
