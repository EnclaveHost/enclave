#!/usr/bin/env python3
"""Regression test for dealer-loop.py's opt-in persistent-child adapter (PersistentDealer +
reconcile_persistent_journal). It drives the adapter against a FAKE shielded-dealer that speaks the
--jobs-stdin protocol (PADS-READY / PADS-DONE / PADS-ERROR), so it needs no model, GPU or real backend.
Covers: the happy path (exact READY/DONE, journal cleared, paths), READY validation (calib, mtp, missing),
mint failure and unexpected DONE (child reaped, adapter dead), client-side range/canonical rejection (no
send), and BOTH fail-closed journal-recovery branches (no-file -> discard; file-exists/malformed -> refuse).
Run: python3 test/dealer-loop-persistent.test.py"""
import importlib.util, json, os, sys, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
DL_PATH = os.path.join(HERE, "..", "shielded", "dealer", "dealer-loop.py")
spec = importlib.util.spec_from_file_location("dealer_loop", DL_PATH)
dl = importlib.util.module_from_spec(spec); spec.loader.exec_module(dl)

FAKE = """#!/usr/bin/env python3
import os, sys
mtp = "1" if "--mtp" in sys.argv else "0"
calib = os.environ.get("FAKE_CALIB_HEX", "a"*64)
mode = os.environ.get("FAKE_MODE", "ok")   # ok|badcalib|badmtp|error|wrongdone|noready
outdir = sys.argv[sys.argv.index("--jobs-stdin")+1] if "--jobs-stdin" in sys.argv else None
sys.stderr.write("fake dealer: chatter to stderr\\n"); sys.stderr.flush()
if mode == "noready": sys.exit(3)
if mode == "badcalib": calib = "b"*64
rmtp = "0" if mode == "badmtp" else mtp
sys.stdout.write(f"PADS-READY 1 mtp={rmtp} calib={calib}\\n"); sys.stdout.flush()
for line in sys.stdin:
    f = line.rstrip("\\n").split("\\t")
    if len(f) != 6:
        sys.stdout.write("PADS-ERROR 0 protocol\\n"); sys.stdout.flush(); sys.exit(2)
    seq, seed, sid, pk, i0, c = f
    if mode == "error":
        sys.stdout.write(f"PADS-ERROR {seq} mint-failed\\n"); sys.stdout.flush(); sys.exit(1)
    if mode == "wrongdone":
        sys.stdout.write(f"PADS-DONE {int(seq)+9} {sid} {i0} {c}\\n"); sys.stdout.flush(); sys.exit(1)
    if outdir and not os.environ.get("FAKE_NOFILE"):
        open(os.path.join(outdir, f"{sid}-{i0}-{c}.pads"), "w").write("pad")
    sys.stdout.write(f"PADS-DONE {seq} {sid} {i0} {c}\\n"); sys.stdout.flush()
"""

CAL, SEED, SID, PK = "c"*64, "a"*64, "b"*32, "d"*64
_scratch = tempfile.mkdtemp(prefix="dealer-persistent-test-")
_fake = os.path.join(_scratch, "fake-dealer.py")
open(_fake, "w").write(FAKE); os.chmod(_fake, 0o755)

def newpd(out, mode="ok", nofile=False, mtp=1):
    os.environ["FAKE_CALIB_HEX"] = CAL; os.environ["FAKE_MODE"] = mode
    os.environ.pop("FAKE_NOFILE", None)
    if nofile: os.environ["FAKE_NOFILE"] = "1"
    return dl.PersistentDealer(_fake, "model.gguf", "dummy-calib", out, mtp, CAL,
                               startup_timeout=15, mint_timeout=15)

def out():
    return tempfile.mkdtemp(prefix="dealer-persistent-out-")

def journal(d):
    return os.path.join(d, ".dealer-loop.journal")

n = 0

# 1 happy path: two ranges, journal cleared, paths correct
d = out(); pd = newpd(d)
p1 = pd.mint_range(SEED, SID, PK, 0, 64); p2 = pd.mint_range(SEED, SID, PK, 64, 32)
assert p1.endswith(f"{SID}-0-64.pads") and os.path.exists(p1)
assert p2.endswith(f"{SID}-64-32.pads") and os.path.exists(p2)
assert not os.path.exists(journal(d)) and pd.seq == 2
pd.close(); assert pd.dead
print("1 happy path (exact READY/DONE, journal cleared) OK"); n += 1

# 2-4 READY validation
for mode, needle, label in (("badcalib", "calib", "2 bad READY calib refused"),
                            ("badmtp", "mtp", "3 READY mtp mismatch refused"),
                            ("noready", "READY", "4 missing READY refused")):
    try: newpd(out(), mode=mode); assert False
    except RuntimeError as e: assert needle in str(e); print(label + " OK"); n += 1

# 5 mint ERROR -> dead
pd = newpd(out(), mode="error")
try: pd.mint_range(SEED, SID, PK, 0, 64); assert False
except RuntimeError: assert pd.dead; print("5 mint-failed -> child reaped, adapter dead OK"); n += 1

# 6 unexpected DONE -> dead
pd = newpd(out(), mode="wrongdone")
try: pd.mint_range(SEED, SID, PK, 0, 64); assert False
except RuntimeError as e: assert "expected" in str(e) and pd.dead; print("6 unexpected DONE -> dead OK"); n += 1

# 7 client-side range rejection (no send, not dead)
pd = newpd(out())
try: pd.mint_range(SEED, SID, PK, 0, 5000); assert False
except RuntimeError as e: assert "range" in str(e) and not pd.dead; print("7 out-of-range rejected client-side OK"); n += 1
pd.close()

# 7b non-canonical hex rejected
pd = newpd(out())
try: pd.mint_range("zz", SID, PK, 0, 64); assert False
except RuntimeError as e: assert "canonical" in str(e); print("7b non-canonical seed rejected OK"); n += 1
pd.close()

# 8 journal recovery: pending + NO file -> discard (planning re-mints)
d = out()
json.dump({"seq": 1, "seed_id": SID, "index0": 0, "count": 64, "pk": PK, "mtp": 1, "ts": 0, "state": "in-flight"},
          open(journal(d), "w"))
dl.reconcile_persistent_journal(d)
assert not os.path.exists(journal(d))
print("8 journal recovery (no file) -> discard OK"); n += 1

# 9 journal recovery: pending + file EXISTS -> fail closed
d = out()
json.dump({"seq": 1, "seed_id": SID, "index0": 0, "count": 64, "pk": PK, "mtp": 1, "ts": 0, "state": "in-flight"},
          open(journal(d), "w"))
open(os.path.join(d, f"{SID}-0-64.pads"), "w").write("x")
try: dl.reconcile_persistent_journal(d); assert False
except SystemExit as e: assert e.code and "Refusing" in str(e.code); print("9 journal recovery (file exists) -> fail closed OK"); n += 1

# 10 malformed journal -> fail closed
d = out(); open(journal(d), "w").write("{not json")
try: dl.reconcile_persistent_journal(d); assert False
except SystemExit as e: assert "malformed" in str(e.code); print("10 malformed journal -> fail closed OK"); n += 1

assert n == 11, n
print(f"dealer-loop persistent adapter: {n}/11 PASS")
