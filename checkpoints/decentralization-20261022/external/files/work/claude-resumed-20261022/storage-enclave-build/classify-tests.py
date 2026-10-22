#!/usr/bin/env python3
"""Classify `go test -json` results: pass / skip / fail. Each failure is either POSTGRES_UNAVAILABLE (its output shows the
connection to 127.0.0.1:5432 being refused, the only PostgreSQL that testutils.NewDB tries) or OTHER.
Package build failures count as OTHER. Exit 0 iff there is no OTHER failure."""
import collections, json, re, sys
out, res, pkgres = collections.defaultdict(list), {}, {}
for line in open(sys.argv[1]):
    line = line.strip()
    if not line.startswith("{"): continue
    e = json.loads(line); key = (e.get("Package"), e.get("Test"))
    if e.get("Action") == "output": out[key].append(e.get("Output", ""))
    elif e.get("Action") in ("pass", "fail", "skip"):
        (res if e.get("Test") else pkgres)[key] = e["Action"]
PG = re.compile(r"127\.0\.0\.1:5432|connect: connection refused|failed to connect to .*5432", re.I)
top = {k: v for k, v in res.items() if "/" not in k[1]}          # top-level tests; subtests roll up into them
cls = collections.Counter(); other = []
for k, v in sorted(top.items()):
    if v != "fail": cls[v] += 1; continue
    text = "".join(out[k]) + "".join(x for kk, xs in out.items() if kk[0] == k[0] and kk[1] and kk[1].startswith(k[1] + "/") for x in xs)
    if PG.search(text): cls["fail:POSTGRES_UNAVAILABLE"] += 1
    else: cls["fail:OTHER"] += 1; other.append((k, text[-1500:]))
for (pkg, _), v in sorted(pkgres.items()):
    if v == "fail" and not any(kk[0] == pkg and vv == "fail" for kk, vv in top.items()):
        cls["fail:OTHER(package)"] += 1; other.append(((pkg, None), "".join(out[(pkg, None)])[-1500:]))
print("packages:", dict(collections.Counter(pkgres.values())), {p: v for (p, _), v in sorted(pkgres.items())})
print("top-level tests:", dict(cls))
for name in ("pass", "skip"):
    print(f"{name}:", " ".join(sorted(f"{k[1]}" for k, v in top.items() if v == name)))
print("fail:POSTGRES_UNAVAILABLE:", " ".join(sorted(k[1] for k, v in top.items() if v == "fail" and k not in dict(other))))
for k, text in other: print("OTHER FAILURE", k, "\n", text)
sys.exit(1 if other else 0)
