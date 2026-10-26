#!/usr/bin/env python3
"""status.py OUTDIR VARIANTS (r2; guest at the end of diag.sh AND host on whatever partial out/ was fetched). Derives a TRUTHFUL
diagnostic status from the files actually present: per phase complete | incomplete:<why> | not-requested, and invariant violations
(production PIDs changed, own listener still bound, PIDs never re-checked). Observations (timings, timeouts, errors inside the probes)
are NOT pass/fail here: this is a diagnostic, never a capture, readiness or finality verdict.
Exit 30 = invariant violation, 10 = incomplete, 0 = every requested phase complete and invariants hold."""
import json, pathlib, sys
o = pathlib.Path(sys.argv[1]); V = sys.argv[2].split()
def lines(p):
    return (o / p).read_text().splitlines() if (o / p).exists() else []
def js(p):
    try: return json.loads((o / p).read_text())
    except (OSError, ValueError): return None
rc = dict(l.split(None, 1) for l in lines('phase-rc.txt') if ' ' in l)
ph = {}
a = js('el-probe.json')
ph['A'] = 'complete' if rc.get('A') == '0' and a and a.get('finishedAt') and a.get('finalized') else \
    f"incomplete: rc={rc.get('A', 'missing')}, el-probe.json={'present' if a else 'missing'}"
for q in ('100', '400'):
    if q not in V:
        ph['B' + q] = 'not-requested'; continue
    h = js(f'helios-probe-{q}.json')
    ok = rc.get('B' + q) == '0' and h and h.get('finalized') and len(h.get('steps', [])) == 4 and (o / f'el-requests-{q}.jsonl').exists()
    ph['B' + q] = 'complete' if ok else f"incomplete: rc={rc.get('B' + q, 'missing')}, probe={'present' if h else 'missing'}"
inv = lines('invariants.txt')
if not any((o / p).exists() for p in ('pids-after.txt', 'pids-after-cleanup.txt')):
    inv.append('production PIDs were never re-checked (unknown)')
st = {'format': 'enclave-guest-call-diagnostic-status/v2', 'kind': 'diagnostic observations only; NOT a capture, readiness or finality verdict',
      'variants': V, 'phases': ph, 'invariants': {'ok': not inv, 'violations': inv},
      'complete': all(v in ('complete', 'not-requested') for v in ph.values())}
(o / 'status.json').write_text(json.dumps(st, indent=1) + '\n'); print(json.dumps(st))
sys.exit(30 if inv else 0 if st['complete'] else 10)
