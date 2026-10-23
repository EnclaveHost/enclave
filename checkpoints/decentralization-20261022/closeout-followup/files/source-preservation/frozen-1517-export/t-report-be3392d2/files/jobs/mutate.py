#!/usr/bin/env python3
"""Mutation controls for the NEW integration guards only, each run as the full guest test in a scratch copy (mut/), never
the committed clones. A mutant is KILLED when the run fails AT its named guest step(s)."""
import json, os, shutil, subprocess, sys
W = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
M = f"{W}/mut"
SN = ["s/holder/storage_nbd.py", "p/l1pair/vendor/holder/storage_nbd.py"]
MUTANTS = [
  ("G1-consumer-not-bound-to-watch", [("s/holder/holder.py", "\\nRequires={name}-watch.service\\nBindsTo={name}-watch.service", "\\nRequires={name}-watch.service"),
                                     ("p/l1pair/vendor/holder/holder.py", "\\nRequires={name}-watch.service\\nBindsTo={name}-watch.service", "\\nRequires={name}-watch.service"),
                                     ("p/l1pair/l1pair.py", "(f'\\nBindsTo={gate}' if network else '')", "''")],
   ["l1-disconnect-supervision-stops-consumers", "base-disconnect-supervision-stops-consumers"]),
  ("G2-cache-gate-bypassed", [(f, "            cache_gate(c, dev)\n", "            pass\n") for f in SN], ["B3a-uncached-write-detected-assemble-refused"]),
  ("G3-detach-ignores-holders-and-mounts", [("t/transport/hddattach.py", "    if held:\n", "    if False:\n"),
                                          ("t/transport/hddattach.py", "    if foreign:\n", "    if False:\n")],
   ["C6-transport-detach-refused-while-storage-holds-the-device"]),
  ("G4-assemble-ignores-nonempty-mountpoint", [(f, "    elif os.path.lexists(mnt) and os.listdir(mnt):", "    elif False:") for f in SN],
   ["C4-stray-file-in-bare-mount-point-refused"]),
  ("G4b-assemble-ignores-nonempty-mountpoint-both-checks",
   [(f, "    elif os.path.lexists(mnt) and os.listdir(mnt):", "    elif False:") for f in SN]
   + [(f, "        if os.listdir(mnt):\n            die(f\"{mnt} is not empty", "        if False:\n            die(f\"{mnt} is not empty") for f in SN],
   ["C4-stray-file-in-bare-mount-point-refused"]),
  ("G5-watch-without-direct-probe", [("t/transport/hddwatch.py", "    probe(dev, (n % 256) * 4096, w[\"probeTimeoutSec\"])\n", "    pass\n")], None),
]
only = set(sys.argv[1:])


def fresh():
    shutil.rmtree(M, ignore_errors=True); os.makedirs(M)
    for d in ("t", "s", "p", "itest", "jobs"):
        subprocess.run(["rsync", "-a", "--exclude", "__pycache__", f"{W}/{d}/", f"{M}/{d}/"], check=True)


def run(tag):
    out = f"{W}/logs/mut-{tag}.out"
    rc = subprocess.run(["bash", f"{M}/itest/run.sh"], stdout=open(out, "w"), stderr=subprocess.STDOUT).returncode
    runp = next((l.split("=", 1)[1].strip() for l in open(out) if l.startswith("run=")), None)
    try:
        g = json.load(open(f"{runp}/out/results.json"))
    except Exception:
        g = []
    return rc, [x["step"] for x in g if not x["ok"]], len(g)


bad = 0
fresh(); rc, failed, n = run("control")
print(f"CONTROL rc={rc} guestSteps={n} failed={failed}", flush=True)
if rc != 0:
    print("RESULT FAIL (control)"); sys.exit(1)
for name, edits, want in MUTANTS:
    if only and name not in only:
        continue
    fresh()
    ok = True
    for f, a, b in edits:
        t = open(f"{M}/{f}").read()
        if t.count(a) != 1:
            print(f"ERROR {name}: anchor count {t.count(a)} in {f}"); ok = False; break
        open(f"{M}/{f}", "w").write(t.replace(a, b))
    if not ok:
        bad += 1; continue
    rc, failed, n = run(name)
    if want is None:
        print(f"ASSESSED {name}: rc={rc} guestSteps={n} failed={failed}", flush=True); continue
    killed = rc != 0 and all(s in failed for s in want)
    print(f"{'KILLED' if killed else 'SURVIVED'} {name}: rc={rc} guestSteps={n} failed={failed}", flush=True)
    bad += 0 if killed else 1
shutil.rmtree(M, ignore_errors=True)
print(f"RESULT {'PASS' if bad == 0 else 'FAIL'} ({bad} problem(s))"); sys.exit(1 if bad else 0)
