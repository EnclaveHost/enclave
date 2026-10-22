#!/usr/bin/env python3
"""Offline (no network): per 1538-s cycle, the best instant's MIN remaining lease across all apps, and which app limits it.
Usage: cycle-maxima.py chain-probe.json rpc-url hours"""
import json, sys, datetime
p = json.load(open(sys.argv[1])); r = p["rpcs"][sys.argv[2]]; ev = r["events"]; head = r["head"]["timestamp"]; H = float(sys.argv[3])
iso = lambda t: datetime.datetime.fromtimestamp(t, datetime.timezone.utc).strftime("%H:%M:%S")
seg = {i: [(e["blockTime"], e["leaseUntil"]) for e in v] for i, v in ev.items()}
def until(i, t):
    u = None
    for bt, lu in seg[i]:
        if bt <= t: u = lu
    return u
t0 = int(head - H * 3600); rows = []
for t in range(t0, head + 1):
    rem = sorted((until(i, t) - t, i[:10]) for i in seg)
    rows.append((t, rem[0][0], rem[0][1], rem[1][0], rem[1][1]))
C = 1538
for k in range(int((head - t0) // C) + 1):
    w = [x for x in rows if t0 + k * C <= x[0] < t0 + (k + 1) * C]
    if not w: continue
    b = max(w, key=lambda x: x[1])
    print(f"cycle {iso(w[0][0])}-{iso(w[-1][0])}: best min {b[1]} s at {iso(b[0])}Z (limit {b[2]}; next {b[3]} {b[4]})")
