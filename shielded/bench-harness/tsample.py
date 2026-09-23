#!/usr/bin/env python3
"""Passive thread-placement sampler for one bench process: every 0.5 s, each
thread's last CPU and its CPU-time delta. Writes one line per sample:
  t main_cpu main_busy sib_hot core_hot ccd0_hot ccd1_hot hot_threads
where 'hot' = a thread that used > 40% of the interval. CCD0 = CPUs 0-7,16-23."""
import os, sys, time
out = open(sys.argv[1], 'w'); pid = None
HZ = os.sysconf('SC_CLK_TCK')
def ccd(c): return 0 if (c % 16) < 8 else 1
def core(c): return c % 16
prev = {}
t_end = time.monotonic() + 1200
while time.monotonic() < t_end:
    if pid is None:
        for d in os.listdir('/proc'):
            if d.isdigit():
                try:
                    if open(f'/proc/{d}/comm').read().strip() == 'bench-spec2': pid = d; break
                except OSError: pass
        if pid is None: time.sleep(0.2); continue
    if not os.path.exists(f'/proc/{pid}'): break
    now = time.monotonic(); cur = {}
    try:
        for tid in os.listdir(f'/proc/{pid}/task'):
            try: f = open(f'/proc/{pid}/task/{tid}/stat').read().rsplit(')', 1)[1].split()
            except OSError: continue
            cur[tid] = (int(f[36]), int(f[11]) + int(f[12]))    # processor, utime+stime
    except OSError: break
    if prev:
        dt = now - prev_t
        busy = {t: (c[1] - prev[t][1]) / HZ / dt for t, c in cur.items() if t in prev}
        hot = [t for t, b in busy.items() if b > 0.4]
        mc = cur.get(pid, (-1, 0))[0]
        sib = sum(1 for t in hot if t != pid and cur[t][0] != mc and core(cur[t][0]) == core(mc))
        same = sum(1 for t in hot if t != pid and cur[t][0] == mc)
        c0 = sum(1 for t in hot if ccd(cur[t][0]) == 0); c1 = len(hot) - c0
        out.write(f"{now:.2f} {mc} {busy.get(pid, 0):.2f} {sib} {same} {c0} {c1} {len(hot)}\n"); out.flush()
    prev, prev_t = cur, now
    time.sleep(0.5)
