#!/usr/bin/env python3
"""Offline (no network). From a chain-probe JSON: (1) at given UTC instants, each app's ACTUAL remaining lease (chain events)
and the apps under a threshold; (2) a FORECAST of the next hours under the observed renewal model:
  free lease (rate 0): renewed when remaining < 285 s at a 30-s tick, landing with r s left, new leaseUntil = landing + 1800
  paid lease (0x59f1): new leaseUntil = old leaseUntil + 1800 (EnclaveDeployments._burnLease), landing with r s left
with r = 250 (central; observed normal landings 222..280). Prints per-cycle best instants and the gate windows.
Usage: forecast.py chain-probe.json rpc-url hours [ISO-instant ...]"""
import json, sys, datetime
p = json.load(open(sys.argv[1])); r = p["rpcs"][sys.argv[2]]; ev = r["events"]; head = r["head"]["timestamp"]; H = float(sys.argv[3])
iso = lambda t: datetime.datetime.fromtimestamp(t, datetime.timezone.utc).strftime("%H:%M:%SZ")
ep = lambda s: int(datetime.datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp())
seg = {i: [(e["blockTime"], e["leaseUntil"]) for e in v] for i, v in ev.items()}
paid = {i for i, v in ev.items() if any(e["newRemainingSec"] > 1800 for e in v)}
def until(i, t):
    u = None
    for bt, lu in seg[i]:
        if bt <= t: u = lu
    return u
out = {"head": iso(head), "paid": sorted(x[:10] for x in paid), "instants": {}, "forecast": {}}
for s in sys.argv[4:]:
    t = ep(s); rem = {i[:10]: until(i, t) - t for i in seg}
    out["instants"][s] = {"remaining": dict(sorted(rem.items(), key=lambda x: x[1])), "under1200": sorted(k for k, v in rem.items() if v < 1200)}
R = 250
lu = {i: until(i, head) for i in seg}
rows = []
for t in range(head, int(head + H * 3600)):
    for i in seg:
        if lu[i] - t <= R: lu[i] = (lu[i] + 1800) if i in paid else (t + 1800)
    m = min((lu[i] - t, i[:10]) for i in seg); rows.append((t, m[0], m[1]))
cycles, k = [], 0
while k < len(rows):
    w = rows[k:k + 1538]; b = max(w, key=lambda x: x[1]); cycles.append({"bestAt": iso(b[0]), "minRemaining": b[1], "limitedBy": b[2]}); k += 1538
out["forecast"] = {"model": "free: landing at 250 s left -> landing + 1800; paid: old + 1800", "cycles": cycles}
for X in (1200, 900, 780, 660):
    runs, cur = [], None
    for t, m, _ in rows:
        if m >= X:
            if cur and t == cur[1] + 1: cur[1] = t
            else: cur = [t, t]; runs.append(cur)
    out["forecast"][f"windows>={X}"] = [[iso(a), iso(b), b - a + 1] for a, b in runs][:8]
print(json.dumps(out, indent=1))
