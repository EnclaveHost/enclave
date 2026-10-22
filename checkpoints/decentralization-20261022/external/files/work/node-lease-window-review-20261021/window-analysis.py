#!/usr/bin/env python3
"""Offline analysis of a chain-probe JSON (no network): each app's leaseUntil timeline from its Renewed/Claimed events, then
for every second the MIN remaining lease across the apps, and how long a cutover gate of X seconds was satisfiable.
Usage: window-analysis.py chain-probe-*.json [rpc-url]  ->  prints JSON (the RESULT quotes it)."""
import json, sys, datetime

p = json.load(open(sys.argv[1]))
rpc = sys.argv[2] if len(sys.argv) > 2 else next(u for u, r in p["rpcs"].items() if not r.get("error"))
r = p["rpcs"][rpc]; ev = r["events"]; head = r["head"]["timestamp"]
iso = lambda t: datetime.datetime.fromtimestamp(t, datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
ids = sorted(ev)
start = max(e[0]["blockTime"] for e in ev.values())          # from the moment EVERY app has a known leaseUntil
seg = {i: [(e["blockTime"], e["leaseUntil"]) for e in ev[i]] for i in ids}

def until(i, t):
    u = None
    for bt, lu in seg[i]:
        if bt <= t: u = lu
        else: break
    return u

mins = []                                                   # (t, min remaining, the app with it)
for t in range(start, head + 1):
    rem = [(until(i, t) - t, i) for i in ids]
    m = min(rem); mins.append((t, m[0], m[1]))
lapses = [x for x in mins if x[1] < 0]
best = max(mins, key=lambda x: x[1])
gates = {}
for X in (1200, 1080, 960, 900, 720, 660, 600, 540):
    ok = [t for t, m, _ in mins if m >= X]
    runs, cur = [], None
    for t in ok:
        if cur and t == cur[1] + 1: cur[1] = t
        else:
            cur = [t, t]; runs.append(cur)
    gates[X] = {"secondsSatisfiable": len(ok), "fraction": round(len(ok) / len(mins), 4), "windows": len(runs),
                "longestWindowSec": max((b - a + 1 for a, b in runs), default=0),
                "last3": [[iso(a), iso(b)] for a, b in runs[-3:]]}
# per-app: renewal period and the remaining at landing (the host's effective lead)
per = {}
for i in ids:
    e = ev[i]; per[i] = {"renewals": len(e), "remainingAtLanding": [x["remainingAtSendSec"] for x in e[1:]],
        "newRemaining": sorted({x["newRemainingSec"] for x in e}), "periodSec": [e[k]["blockTime"] - e[k - 1]["blockTime"] for k in range(1, len(e))]}
allLanding = [v for x in per.values() for v in x["remainingAtLanding"] if v is not None]
# the phase spread NOW: the 8 free leases (newRemaining 1800) renew at blockTime; their circular span on a ~cycle
free = [i for i in ids if per[i]["newRemaining"] == [1800]]
last = sorted((ev[i][-1]["blockTime"], i) for i in free)
cyc = sorted(v for i in free for v in per[i]["periodSec"]); cycle = cyc[len(cyc) // 2]
ts = [t for t, _ in last]; gaps = [(ts[(k + 1) % len(ts)] + (cycle if k == len(ts) - 1 else 0) - ts[k], last[k][1]) for k in range(len(ts))]
mg = max(gaps)
print(json.dumps({"rpc": rpc, "from": iso(start), "to": iso(head), "seconds": len(mins), "apps": len(ids),
    "lapsesObserved": len(lapses), "bestMinRemaining": {"sec": best[1], "at": iso(best[0])},
    "minRemainingNow": {"sec": mins[-1][1], "app": mins[-1][2][:10], "at": iso(mins[-1][0])},
    "gates": gates, "landingRemaining": {"min": min(allLanding), "max": max(allLanding), "n": len(allLanding)},
    "medianFreeCycleSec": cycle, "freeApps": len(free),
    "freePhaseCircularSpanSec": cycle - mg[0], "bestAchievableMinRemainingFromSpan": 1800 - (cycle - mg[0]),
    "perApp": {i[:10]: {k: (v if k != "remainingAtLanding" else [min(x for x in v if x is not None), max(x for x in v if x is not None)]) if k in ("remainingAtLanding",) else v
                        for k, v in per[i].items() if k != "periodSec"} | {"periodRange": [min(per[i]["periodSec"]), max(per[i]["periodSec"])]} for i in ids}}, indent=1))
