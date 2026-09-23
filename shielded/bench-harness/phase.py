#!/usr/bin/env python3
"""Phase attribution from the cumulative per-graph trace.

Every figure names its denominator. The units that get confused here are:
  per GRAPH        one graph_compute call on one card
  per PASS         one forward pass of the model (many graphs)
  per TOKEN        one GENERATED token (a spec round yields ~1+acc of them)
  per CARD         these counters are per card; cards run CONCURRENTLY and
                   their times must never be summed as if sequential
Records are cumulative, so a phase figure is the difference of its endpoints
and no reset can corrupt it.
"""
import re, sys, json, os
B = os.path.dirname(os.path.abspath(__file__))
R = re.compile(r'\[ph\] card=(\d+) t=([\d.]+) m=(\d+) graphs=(\d+) nodes=(\d+) ex=(\d+) idle=([\d.]+) link=([\d.]+) graph=([\d.]+)')

def main(label, card=0, gap_s=1.0):
    rows = []
    for line in open(f"{B}/{label}.err", errors="replace"):
        m = R.match(line)
        if m and int(m[1]) == card:
            rows.append(dict(t=float(m[2]), m=int(m[3]), graphs=int(m[4]), nodes=int(m[5]),
                             ex=int(m[6]), idle=float(m[7]), link=float(m[8]), graph=float(m[9])))
    if len(rows) < 10: print("no trace"); return 1
    j = json.loads(open(f"{B}/{label}.json").read().strip().splitlines()[-1])
    # split on large wall gaps between consecutive graphs
    segs, cur = [], [rows[0]]
    for a, b in zip(rows, rows[1:]):
        if b["t"] - a["t"] > gap_s: segs.append(cur); cur = []
        cur.append(b)
    segs.append(cur)
    segs = [s for s in segs if len(s) > 5]
    print(f"{label} card {card}: {len(rows)} graphs, {len(segs)} segments (split on >{gap_s}s wall gaps)")
    print(f"  bench: plain {j['plain_generated']} tok @ {j['plain_ms_per_tok']:.2f} ms, "
          f"spec {j['generated']} tok in {j['rounds']} rounds @ {j['decode_ms_per_tok']:.2f} ms\n")
    print(f"{'seg':>3} {'graphs':>7} {'m':>8} {'wall_s':>7} {'d_ex':>7} {'ex/graph':>9} {'d_idle':>8} {'d_link':>8} {'d_graph':>8}")
    for i, sg in enumerate(segs):
        a, b = sg[0], sg[-1]
        ms = {}
        for r in sg: ms[r["m"]] = ms.get(r["m"], 0) + 1
        mdesc = ",".join(f"{k}x{v}" for k, v in sorted(ms.items()))
        dg = b["graphs"] - a["graphs"]
        dex = b["ex"] - a["ex"]
        print(f"{i:3d} {dg:7d} {mdesc:>8} {b['t']-a['t']:7.1f} {dex:7d} "
              f"{dex/max(dg,1):9.2f} {b['idle']-a['idle']:8.1f} {b['link']-a['link']:8.1f} {b['graph']-a['graph']:8.1f}")
    return 0

if __name__ == "__main__":
    sys.exit(main(sys.argv[1] if len(sys.argv) > 1 else "phase-1",
                  int(sys.argv[2]) if len(sys.argv) > 2 else 0))
