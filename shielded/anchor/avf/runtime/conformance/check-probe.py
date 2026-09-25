#!/usr/bin/env python3
"""check-probe.py <console> -- a pVM rt_probe run against runtime/conformance/vectors.json: each case's stdout lines and exit
code must equal the reference exactly, every refusal must PASS, W^X must be 0 before and after, the probe must end fails=0,
and the identity must be the contract's pVM identity. Exit 0 only when all of it holds."""
import json, os, re, sys
here = os.path.dirname(os.path.abspath(__file__))
v = json.load(open(os.path.join(here, "vectors.json")))
lines = [re.sub(r"^\[[^]]*\]\[[^]]*\] ", "", l.rstrip("\n")) for l in open(sys.argv[1], errors="replace") if "RT_PROBE" in l and not re.match(r"^\d\d-\d\d ", l)]
lines = [l for l in lines if l.startswith("RT_PROBE ")]
fails = []
def expect(ok, what):
    print(("ok   " if ok else "FAIL ") + what)
    if not ok: fails.append(what)
ident = next((l[len("RT_PROBE identity "):] for l in lines if l.startswith("RT_PROBE identity ")), "")
want_id = {"cache": "none", "cpuFeatures": "baseline", "execution": "interpreter", "hostIsa": "aarch64", "name": "wasmtime", "targetIsa": "pulley64", "version": "49.0.0", "wx": "enforced"}
expect(ident and json.loads(ident) == want_id, "identity is the contract's pVM identity " + ident)
expect(f"RT_PROBE bundle bytes={os.path.getsize(os.path.join(here, v['bundle']))} pinned={v['bundle_sha256']}" in lines, "the probe ran the vectors' bundle under its pin")
for i, c in enumerate(v["cases"]):
    name = f"case{i}"
    try: b = lines.index(f"RT_PROBE begin {name}")
    except ValueError: expect(False, f"{name} ran"); continue
    e = next((j for j in range(b, len(lines)) if lines[j].startswith(f"RT_PROBE end {name} ")), None)
    if e is None: expect(False, f"{name} finished (the probe ended inside it)"); continue
    out = "".join(l[len("RT_PROBE stdout "):] + "\n" for l in lines[b + 1:e] if l.startswith("RT_PROBE stdout "))
    m = re.search(r"rc=(-?\d+) exit=(-?\d+)", lines[e])
    expect(m and m.group(1) == "0" and int(m.group(2)) == c["exit"], f"{name} {c['args']} ran and exited {c['exit']}")
    expect(out == c["stdout"], f"{name} {c['args']} stdout is the reference's, byte for byte")
for r in ("digest", "memory", "deadline"):
    expect(any(l.startswith(f"RT_PROBE refusal {r} PASS") for l in lines), f"refusal {r}")
expect("RT_PROBE wx_before=0" in lines and "RT_PROBE wx_after=0" in lines, "no writable+executable mapping before or after")
expect("RT_PROBE done fails=0" in lines, "the probe itself reports no failure")
print("PASS conformance in the pVM" if not fails else f"FAIL ({len(fails)})"); sys.exit(1 if fails else 0)
