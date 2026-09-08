#!/usr/bin/env python3
"""Regression test for dealer-loop.py's opt-in persistent-child adapter (PersistentDealer +
reconcile_persistent_journal). It drives the adapter against a FAKE shielded-dealer that speaks the
--jobs-stdin protocol, so it needs no model, GPU or real backend. Beyond the happy path it establishes the
guarantees the adapter claims: bounded reads (flood / no-LF / unsolicited output, before and after READY),
the shared absolute send+read deadline (blocked pipe, silent child) with kill+reap and every fd closed,
durable-journal faults failing closed (unwritable bank on write, on clear), one job in flight under a
concurrent call, config/type validation (non-finite timeouts, bool ranges, uint64 sequence), and the
no-bypass recovery policy: a live child refuses, a verified-stopped child with no file discards, a stopped
child with a present file refuses; malformed/symlinked/oversized journals refuse; and a run WITHOUT the
flag still refuses (no bypass through the plain mode).
Run: python3 test/dealer-loop-persistent.test.py   (~10 s, host-only)"""
import importlib.util, json, os, subprocess, sys, tempfile, threading, time

HERE = os.path.dirname(os.path.abspath(__file__))
DL_PATH = os.path.abspath(os.path.join(HERE, "..", "shielded", "dealer", "dealer-loop.py"))
spec = importlib.util.spec_from_file_location("dealer_loop", DL_PATH)
dl = importlib.util.module_from_spec(spec); spec.loader.exec_module(dl)

FAKE = r'''#!/usr/bin/env python3
import os, sys, time
out = sys.stdout.buffer
mtp = "1" if "--mtp" in sys.argv else "0"
calib = os.environ.get("FAKE_CALIB_HEX", "a"*64)
mode = os.environ.get("FAKE_MODE", "ok")
outdir = sys.argv[sys.argv.index("--jobs-stdin")+1] if "--jobs-stdin" in sys.argv else None
sys.stderr.write("fake dealer: chatter to stderr\n"); sys.stderr.flush()
if mode == "noready": sys.exit(3)
if mode == "floodready": out.write(b"x" * (1 << 20)); out.flush(); time.sleep(5); sys.exit(0)
if mode == "badcalib": calib = "b"*64
rmtp = "0" if mode == "badmtp" else mtp
out.write(f"PADS-READY 1 mtp={rmtp} calib={calib}\n".encode()); out.flush()
if mode == "readychatter": out.write(b"EXTRA with ready\n"); out.flush()
if mode == "prechatter": time.sleep(0.3); out.write(b"EXTRA before any request\n"); out.flush()
if mode == "quietexit": sys.exit(0)
if mode == "sleep": time.sleep(30); sys.exit(0)
for line in sys.stdin.buffer:
    f = line.rstrip(b"\n").decode().split("\t")
    if len(f) != 6: out.write(b"PADS-ERROR 0 protocol\n"); out.flush(); sys.exit(2)
    seq, seed, sid, pk, i0, c = f
    if mode == "error": out.write(f"PADS-ERROR {seq} mint-failed\n".encode()); out.flush(); sys.exit(1)
    if mode == "wrongdone": out.write(f"PADS-DONE {int(seq)+9} {sid} {i0} {c}\n".encode()); out.flush(); sys.exit(1)
    if mode == "flood": out.write(b"y" * (1 << 20)); out.flush(); time.sleep(5); sys.exit(0)
    if mode == "slowok": time.sleep(float(os.environ.get("FAKE_SLOW", "1.0")))
    if outdir and not os.environ.get("FAKE_NOFILE"):
        open(os.path.join(outdir, f"{sid}-{i0}-{c}.pads"), "w").write("pad")
    out.write(f"PADS-DONE {seq} {sid} {i0} {c}\n".encode())
    if mode == "chatty": out.write(b"EXTRA after done\n")
    out.flush()
'''
CAL, MSHA, SEED, SID, PK = "c"*64, "e"*64, "a"*64, "b"*32, "d"*64
_scratch = tempfile.mkdtemp(prefix="dealer-persistent-test-")
_fake = os.path.join(_scratch, "fake-dealer.py"); open(_fake, "w").write(FAKE); os.chmod(_fake, 0o755)

def newpd(out, mode="ok", nofile=False, mtp=1, slow=None, **kw):
    os.environ["FAKE_CALIB_HEX"] = CAL; os.environ["FAKE_MODE"] = mode
    os.environ.pop("FAKE_NOFILE", None); os.environ.pop("FAKE_SLOW", None)
    if nofile: os.environ["FAKE_NOFILE"] = "1"
    if slow is not None: os.environ["FAKE_SLOW"] = str(slow)
    kw.setdefault("startup_timeout", 15); kw.setdefault("mint_timeout", 15)
    return dl.PersistentDealer(_fake, "model.gguf", "dummy-calib", out, mtp, CAL, MSHA, **kw)

def bank(): return tempfile.mkdtemp(prefix="dealer-persistent-bank-")
def journal(d): return os.path.join(d, dl._JOURNAL_NAME)
def reaped_and_closed(pd):
    p = pd.proc
    assert pd.dead and p.returncode is not None and pd.reaped is True, "child not reaped"
    assert p.stdin.closed and p.stdout.closed and p.stderr.closed, "pipe fds not closed"
    try: os.fstat(pd.dir_fd); raise AssertionError("dir fd not closed")
    except OSError: pass
def expect(fn, exc, needle):
    try: fn()
    except exc as e:
        msg = str(e.code) if isinstance(e, SystemExit) else str(e)
        assert needle in msg, (needle, msg); return msg
    raise AssertionError(f"expected {exc.__name__} containing {needle!r}")
def rec(d, **over):
    r = {"v": 1, "seq": 1, "seed_id": SID, "index0": 0, "count": 64, "pk": PK, "mtp": 1, "model_sha256": MSHA,
         "calib_sha512": CAL, "ts": 0.0, "state": "in-flight", "boot_id": dl._boot_id(), "child_pid": os.getpid(),
         "child_start": dl._proc_start(os.getpid())[1] + 1}   # default: our pid with another incarnation = verified DEAD
    r.update(over); open(journal(d), "w").write(json.dumps(r)); return r

n = 0
# 1 happy path
d = bank(); pd = newpd(d)
p1 = pd.mint_range(SEED, SID, PK, 0, 64); p2 = pd.mint_range(SEED, SID, PK, 64, 32)
assert p1.endswith(f"{SID}-0-64.pads") and os.path.exists(p1) and p2.endswith(f"{SID}-64-32.pads") and os.path.exists(p2)
assert not os.path.exists(journal(d)) and pd.seq == 2 and not [f for f in os.listdir(d) if f.startswith(dl._JOURNAL_NAME)]
pd.close(); assert pd.proc.returncode == 0; reaped_and_closed(pd)
print("1 happy path: exact READY/DONE, journal cleared (no temp left), clean EOF exit 0, fds closed OK"); n += 1

# 2 READY validation incl. a flood before READY (bounded read)
for mode, needle in (("badcalib", "calib"), ("badmtp", "mtp"), ("noready", "READY"), ("floodready", "oversized"), ("readychatter", "unsolicited")):
    expect(lambda: newpd(bank(), mode=mode), RuntimeError, needle)
print("2 READY: bad calib / bad mtp / missing / 1 MiB no-LF flood / extra line with READY all refused OK"); n += 1

# 3 protocol anomalies after READY: each kills+reaps and closes every fd
for mode, needle in (("error", "mint-failed"), ("wrongdone", "expected"), ("flood", "oversized"),
                     ("chatty", "unsolicited"), ("prechatter", "unsolicited"), ("quietexit", "exited")):
    d = bank(); pd = newpd(d, mode=mode)
    if mode in ("quietexit", "prechatter"): time.sleep(0.6)
    expect(lambda: pd.mint_range(SEED, SID, PK, 0, 64), RuntimeError, needle); reaped_and_closed(pd)
print("3 anomalies: ERROR / wrong DONE / 1 MiB flood / extra line after DONE / unsolicited before request / silent exit -> reaped + fds closed OK"); n += 1

# 4 shared absolute deadline: a silent child -> timeout, reaped within bound, journal intent RETAINED
d = bank(); pd = newpd(d, mode="sleep", mint_timeout=1.0); t0 = time.monotonic()
expect(lambda: pd.mint_range(SEED, SID, PK, 0, 64), RuntimeError, "deadline")
assert time.monotonic() - t0 < 8, "kill/reap did not stay bounded"; reaped_and_closed(pd)
assert os.path.exists(journal(d)), "the unresolved intent must survive a timeout"
# ... and recovery: that child is verified stopped and no file exists -> discard
dl.reconcile_persistent_journal(d, MSHA, CAL); assert not os.path.exists(journal(d))
print("4 silent child: 1 s deadline -> reaped in %.1fs, intent retained, then recovery discards it (child verified stopped, no file) OK" % (time.monotonic() - t0)); n += 1

# 5 blocked pipe: the nonblocking writer honours the deadline
r, w = os.pipe(); os.set_blocking(w, False)
try:
    while True: os.write(w, b"x" * 65536)
except BlockingIOError: pass
t0 = time.monotonic(); expect(lambda: dl._write_all(w, b"y" * 10, time.monotonic() + 0.5), TimeoutError, "write deadline")
assert time.monotonic() - t0 < 3; os.close(r); os.close(w)
print("5 full pipe: _write_all raises at the absolute deadline OK"); n += 1

# 6 journal write fault (bank unwritable) -> refuse BEFORE sending; child killed; nothing minted
d = bank(); pd = newpd(d); os.chmod(d, 0o500)
try: expect(lambda: pd.mint_range(SEED, SID, PK, 0, 64), RuntimeError, "cannot journal")
finally: os.chmod(d, 0o700)
reaped_and_closed(pd); assert not os.path.exists(os.path.join(d, f"{SID}-0-64.pads")), "record must not have been sent"
print("6 unwritable bank: intent cannot be journaled -> no send, child reaped OK"); n += 1

# 7 journal clear fault after a published DONE -> fail closed, intent retained
d = bank(); pd = newpd(d, mode="slowok", nofile=True, slow=0.8)
threading.Timer(0.3, lambda: os.chmod(d, 0o500)).start()
try: expect(lambda: pd.mint_range(SEED, SID, PK, 0, 64), RuntimeError, "cannot be cleared")
finally: time.sleep(0.6); os.chmod(d, 0o700)
reaped_and_closed(pd); assert os.path.exists(journal(d))
print("7 clear fault: DONE received but unlink+fsync failed -> dead, intent retained OK"); n += 1

# 8 one in flight: a concurrent call is refused immediately
d = bank(); pd = newpd(d, mode="slowok", slow=1.0); errs = []
t = threading.Thread(target=lambda: pd.mint_range(SEED, SID, PK, 0, 64)); t.start(); time.sleep(0.2)
expect(lambda: pd.mint_range(SEED, SID, PK, 64, 64), RuntimeError, "in flight"); t.join(); pd.close()
print("8 concurrent mint_range -> 'another job is in flight' OK"); n += 1

# 9 client-side validation: ranges, bools, canonical hex, sequence exhaustion, config
d = bank(); pd = newpd(d)
for args, needle in (((SEED, SID, PK, 0, 5000), "range"), ((SEED, SID, PK, True, 64), "range"),
                     ((SEED, SID, PK, 0, True), "range"), (("zz", SID, PK, 0, 64), "canonical")):
    expect(lambda: pd.mint_range(*args), RuntimeError, needle)
assert not pd.dead
pd.seq = dl._UINT64_MAX - 1; expect(lambda: pd.mint_range(SEED, SID, PK, 0, 64), RuntimeError, "exhausted"); reaped_and_closed(pd)
for kw, needle in (({"startup_timeout": float("nan")}, "finite"), ({"mint_timeout": 0}, "finite"), ({"mint_timeout": float("inf")}, "finite"),
                   ({"mtp": True}, "mtp"), ({"mtp": 1.0}, "mtp")):
    expect(lambda: newpd(bank(), **kw), ValueError, needle)
expect(lambda: dl.PersistentDealer(_fake, "m", "c", bank(), 1, "nothex", MSHA), ValueError, "identities")
print("9 validation: range/bool/canonical rejected without send; uint64 exhaustion; non-finite timeouts, bool mtp, bad identities refused OK"); n += 1

# 10 recovery policy (no bypass)
d = bank(); rec(d, child_start=dl._proc_start(os.getpid())[1])         # this very process = a live child
expect(lambda: dl.reconcile_persistent_journal(d, MSHA, CAL), SystemExit, "STILL RUNNING"); assert os.path.exists(journal(d))
d = bank(); rec(d); dl.reconcile_persistent_journal(d, MSHA, CAL); assert not os.path.exists(journal(d))   # stopped + absent -> discard
d = bank(); rec(d); open(os.path.join(d, f"{SID}-0-64.pads"), "w").write("x")
msg = expect(lambda: dl.reconcile_persistent_journal(d, MSHA, CAL), SystemExit, "PRESENT"); assert "no flag" in msg and os.path.exists(journal(d))
d = bank(); rec(d); open(os.path.join(d, f"{SID}-0-64.pads"), "w").write("x")
expect(lambda: dl.reconcile_persistent_journal(d, "f"*64, CAL), SystemExit, "does NOT match")             # identity mismatch is named
for patch, needle in ((("_boot_id", lambda: None), "UNKNOWN"), (("_proc_start", lambda pid: ("unknown", None)), "UNKNOWN"),
                      (("_file_state", lambda p: "unknown"), "cannot stat")):
    d = bank(); rec(d); saved = getattr(dl, patch[0]); setattr(dl, patch[0], patch[1])
    try: expect(lambda: dl.reconcile_persistent_journal(d, MSHA, CAL), SystemExit, needle); assert os.path.exists(journal(d))
    finally: setattr(dl, patch[0], saved)
d = bank(); rec(d, child_start=dl._proc_start(os.getpid())[1])            # a zombie counts as stopped: patch state only
saved = dl._proc_start; dl._proc_start = lambda pid: ("zombie", saved(pid)[1])
try: dl.reconcile_persistent_journal(d, MSHA, CAL); assert not os.path.exists(journal(d))
finally: dl._proc_start = saved
print("10 recovery: live child refuses; stopped+absent discards; stopped+PRESENT refuses with no flag; identity mismatch named; UNKNOWN boot/proc/file all refuse; zombie = stopped OK"); n += 1

# 11 journal parsing is bounded and strict
for over, needle in (({"index0": True}, "range"), ({"seq": 1 << 64}, "seq"), ({"seq": 0}, "seq"), ({"mtp": True}, "mtp"),
                     ({"mtp": 1.0}, "mtp"), ({"v": 1.0}, "version"), ({"v": True}, "version"), ({"ts": float("nan")}, "ts"),
                     ({"state": "done"}, "state"), ({"child_pid": 0}, "child"), ({"child_pid": 1 << 40}, "child"),
                     ({"boot_id": ""}, "child"), ({"boot_id": "not-a-uuid"}, "child"), ({"child_start": -1}, "child")):
    d = bank(); rec(d, **over); expect(lambda: dl.reconcile_persistent_journal(d, MSHA, CAL), SystemExit, needle)
d = bank(); r = rec(d); del r["pk"]; open(journal(d), "w").write(json.dumps(r)); expect(lambda: dl.reconcile_persistent_journal(d), SystemExit, "schema")
d = bank(); open(journal(d), "w").write("{not json"); expect(lambda: dl.reconcile_persistent_journal(d), SystemExit, "malformed")
d = bank(); r = rec(d); dup = json.dumps(r)[:-1] + ", \"seq\": 2}"; open(journal(d), "w").write(dup)
expect(lambda: dl.reconcile_persistent_journal(d), SystemExit, "duplicate key")
d = bank(); open(journal(d), "w").write("x" * 5000); expect(lambda: dl.reconcile_persistent_journal(d), SystemExit, "oversized")
d = bank(); real = os.path.join(d, "real.json"); open(real, "w").write("{}"); os.symlink(real, journal(d))
expect(lambda: dl.reconcile_persistent_journal(d), SystemExit, "not a regular file")
print("11 journal parsing: bool/float/overflow/zero seq, float/bool mtp and v, NaN ts, state, pid bounds, boot UUID, schema, malformed, DUPLICATE KEY, oversized, symlink all refuse OK"); n += 1

# 12 no bypass through the plain (flag-off) mode: the CLI refuses before any mint/prune
d = bank(); rec(d); open(os.path.join(d, f"{SID}-0-64.pads"), "w").write("x")
r = subprocess.run([sys.executable, DL_PATH, "--out", d, "--seed-id", SID, "--mark", "0", "--once"], capture_output=True, text=True)
assert r.returncode != 0 and "UNRESOLVED" in r.stderr, (r.returncode, r.stderr[-300:])
os.remove(journal(d))
r2 = subprocess.run([sys.executable, DL_PATH, "--out", d, "--seed-id", SID, "--mark", "0", "--once"], capture_output=True, text=True)
assert "minting needs --model" in r2.stderr, r2.stderr[-300:]   # without the journal the same run reaches the mint step
print("12 flag-off CLI run with an unresolved journal refuses before mint/prune; same run proceeds once the journal is gone OK"); n += 1

# 13 startup failures clean up completely: no fd leak, child reaped, dir fd closed (boot UNKNOWN, thread start
#    failure before the drain exists, early child exit, flood before READY)
def nfds(): return len(os.listdir("/proc/self/fd"))
base = nfds()
saved = dl._boot_id; dl._boot_id = lambda: None
try: expect(lambda: newpd(bank()), RuntimeError, "incarnation")
finally: dl._boot_id = saved
assert nfds() == base, "fd leak after boot-unknown startup"
class BadThread(threading.Thread):
    def start(self): raise RuntimeError("thread start refused")
saved_t = dl.threading.Thread; dl.threading.Thread = BadThread
try: expect(lambda: newpd(bank()), RuntimeError, "thread start refused")
finally: dl.threading.Thread = saved_t
assert nfds() == base, "fd leak after thread-start failure"
for mode, needle in (("noready", "READY"), ("floodready", "oversized"), ("badcalib", "calib")):
    expect(lambda: newpd(bank(), mode=mode), RuntimeError, needle); assert nfds() == base, f"fd leak after {mode}"
print("13 startup failures (boot UNKNOWN / drain thread cannot start / early exit / flood / bad calib): cleaned up, no fd leak OK"); n += 1

assert n == 13, n
print(f"dealer-loop persistent adapter: {n}/13 PASS")
