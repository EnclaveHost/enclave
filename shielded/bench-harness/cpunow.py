#!/usr/bin/env python3
"""Per-process CPU use over a WINDOW, not ps's lifetime average (pcpu is total
CPU / elapsed, so a long-lived process that was busy hours ago reads as busy
now, and one that just started a burst reads as idle).

  cpunow.py [SECONDS=2] [THRESHOLD_PCT=50]   prints "comm:pct" for processes
                                             above the threshold, excluding the
                                             bench, its workers and monitors
"""
import os, sys, time
win = float(sys.argv[1]) if len(sys.argv) > 1 else 2.0
thr = float(sys.argv[2]) if len(sys.argv) > 2 else 50.0
SKIP = {'bench-spec2', 'shielded-worker', 'ps', 'grep', 'awk', 'sed', 'pgrep', 'python3', 'cpunow.py'}
hz = os.sysconf('SC_CLK_TCK')
def snap():
    out = {}
    for d in os.listdir('/proc'):
        if not d.isdigit(): continue
        try:
            s = open(f'/proc/{d}/stat').read()
            comm = s[s.index('(') + 1:s.rindex(')')]
            f = s[s.rindex(')') + 2:].split()
            out[d] = (comm, int(f[11]) + int(f[12]))
        except (OSError, ValueError, IndexError):
            pass
    return out
a = snap(); t0 = time.monotonic(); time.sleep(win); b = snap(); dt = time.monotonic() - t0
hits = []
for pid, (comm, tb) in b.items():
    if pid in a and a[pid][0] == comm and comm not in SKIP:
        pct = 100.0 * (tb - a[pid][1]) / hz / dt
        if pct > thr: hits.append((pct, comm))
print(' '.join(f'{c}:{p:.0f}' for p, c in sorted(hits, reverse=True)))
