#!/usr/bin/env python3
"""check-app.py <dir> -- milestone 2's captures (cpu/app-run.sh) against runtime/conformance/vectors.json.
ap-case<i>.log: the pvm-cpu payload ran the delivered component under its announced digest; the APPOUT stdout bytes must
equal the case's reference exactly and `APP ran ... exit=` its exit code; the runtime identity is the contract's pVM identity;
the payload is the pvm-cpu tier. ap-baddigest.log: the announced digest is not the component's, so the VM must refuse it
before compiling (`APP refused: ... refusing to compile`) and never report `APP ran`. Exit 0 only when all of it holds."""
import json, os, re, sys
here = os.path.dirname(os.path.abspath(__file__)); d = sys.argv[1]
v = json.load(open(os.path.join(here, "vectors.json")))
want_id = {"cache": "none", "cpuFeatures": "baseline", "execution": "interpreter", "hostIsa": "aarch64", "name": "wasmtime", "targetIsa": "pulley64", "version": "49.0.0", "wx": "enforced"}
fails = []
def expect(ok, what):
    print(("ok   " if ok else "FAIL ") + what)
    if not ok: fails.append(what)
def lines(name):
    p = os.path.join(d, name)
    return [l.rstrip("\n") for l in open(p, errors="replace")] if os.path.exists(p) else []
for i, c in enumerate(v["cases"]):
    L = lines(f"ap-case{i}.log")
    expect(any("PINS mode=protected" in l and "tier=pvm-cpu" in l for l in L), f"case{i}: the protected pvm-cpu payload ran it")
    rid = next((l.split("APP runtime ", 1)[1] for l in L if "APP runtime " in l), "")
    expect(bool(rid) and json.loads(rid) == want_id, f"case{i}: runtime identity {rid}")
    out = b"".join(bytes.fromhex(m.group(1)) for l in L for m in [re.search(r"APPOUT 1 ([0-9a-f]+)$", l)] if m)
    expect(out.decode("utf-8", "replace") == c["stdout"], f"case{i} {c['args']}: stdout byte-identical to the reference")
    ran = next((re.search(r"APP ran ([0-9a-f]{64}) exit=(-?\d+)", l) for l in L if "APP ran " in l), None)
    expect(bool(ran) and ran.group(1) == v["bundle_sha256"] and int(ran.group(2)) == c["exit"], f"case{i}: ran the vectors' bundle and exited {c['exit']}")
    expect(any(l.startswith("CAPTURE END") and "status=complete" in l for l in L), f"case{i}: capture complete")
B = lines("ap-baddigest.log")
expect(any("APP refused:" in l and "refusing to compile" in l for l in B), "a wrong announced digest: refused before compiling")
expect(not any("APP ran " in l for l in B) and not any("APPOUT " in l for l in B), "... and nothing ran or printed")
if os.environ.get("ABI2_BEFORE_DIGEST") != "1":   # builds before the fix attested the announced AppID before checking the bytes
    expect(not any("ABI2 " in l or "ABI2_LINK" in l for l in B), "... and no ABI/2 certificate was requested for the refused app")
print("PASS milestone 2 on the device" if not fails else f"FAIL ({len(fails)})"); sys.exit(1 if fails else 0)
