#!/usr/bin/env python3
"""Deterministic, isolated tests of the 6144 MiB queue candidate (PREPARED; root runs it after review, inside the CURRENT
shared queue at 256 MiB):
  python3 work/claude-test-queue.py --mib 256 --log $Q/logs/test-6144.guard -- python3 $Q/test-queue-6144.py
Test-only clones (never installed): ROOT re-pointed to a private temp dir (private lock files), MemAvailable from a fixture
file, the 60 s admission deadline shortened to 2 s, `systemd-run` replaced by a stub that records its argv and runs only
the tiny child. The REAL memory-guard.mjs is exercised separately with tiny children (floor and cap stops). No large
allocation, no real cgroup scope, no native work; the real shared locks are never touched."""
import fcntl, hashlib, json, os, signal, subprocess, sys, tempfile, time
from pathlib import Path
HERE = Path(__file__).resolve().parent
WORK = "/home/steven/Documents/Codex/2026-10-18/wo/work"
CURRENT = Path(WORK) / "claude-test-queue.py"
CAND = HERE / "claude-test-queue.candidate-6144.py"
GUARD = Path(WORK) / "enclave/test/helpers/memory-guard.mjs"
PINS = {"current": "969d9273e53c79abf8604c363daa58b41a462bc4b7f3d03d813980edb771f6f4",
        "candidate": "fa0462030ad06c4c283de040cb17cbb2a3d648cc1963f581281b2ceb0b62c4e6",
        "guard": "cdd00af73bcd59040857f2b48a7170fa2303dfdf401152137cd8c35e7a100ca6"}
T = Path(tempfile.mkdtemp(prefix="q6144-", dir=HERE)); results = []; failed = 0
STUB = T / "systemd-run"
STUB.write_text("#!/usr/bin/env python3\nimport json,os,sys\nopen(os.environ['QT_RECORD']+'.pid','w').write(str(os.getpid()))\n"
                "open(os.environ['QT_RECORD'],'w').write(json.dumps(sys.argv[1:]))\n"
                "a=sys.argv[1:]; c=a[a.index('--')+1:]; os.execvp(c[0], c)\n"); STUB.chmod(0o755)
def h(p): return hashlib.sha256(Path(p).read_bytes()).hexdigest()
ROOT_ANCHORS = ['ROOT = Path(__file__).resolve().parent', f'ROOT = Path({WORK!r})']
def clone(src, name, root=None):
    d = T / name; d.mkdir(); s = Path(src).read_text(); r = root or d
    hit = [a for a in ROOT_ANCHORS if s.count(a) == 1]; assert len(hit) == 1, (name, "ROOT anchor")
    s = s.replace(hit[0], f'ROOT = Path({str(r)!r})')
    for a, b in [('Path("/proc/meminfo")', 'Path(os.environ["QT_MEMINFO"])'),
                 ('deadline = time.monotonic() + 60', 'deadline = time.monotonic() + 2'),
                 ('"systemd-run", "--user"', f'{str(STUB)!r}, "--user"')]:
        assert s.count(a) == 1, (name, a); s = s.replace(a, b)
    (d / "q.py").write_text(s); return d
def lock(root, which):
    f = open(Path(root) / ("claude-test-queue.lock" if which == "main" else "claude-test-small-queue.lock"), "a+")
    fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB); return f
def start(d, mib, avail, code=0, sleep=0.0, extra=None):
    mi = d / "meminfo"; mi.write_text(f"MemAvailable:   {avail * 1024} kB\n"); rec = d / "rec.json"; rec.unlink(missing_ok=True)
    env = dict(os.environ, QT_MEMINFO=str(mi), QT_RECORD=str(rec))
    a = [sys.executable, str(d / "q.py"), "--mib", str(mib), "--log", str(d / "g.log")] + (["--extra-start-mib", str(extra)] if extra is not None else [])
    p = subprocess.Popen(a + ["--", sys.executable, "-c", f"import time,sys; time.sleep({sleep}); sys.exit({code})"],
                         stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, env=env)
    return p, rec
def started(rec, t=10):
    end = time.monotonic() + t
    while not rec.exists() and time.monotonic() < end: time.sleep(0.05)
    return rec.exists()
def run(d, mib, avail, code=0, sleep=0.0, extra=None, term=False):
    p, rec = start(d, mib, avail, code, sleep, extra)
    if term: started(rec); time.sleep(0.3); p.send_signal(signal.SIGTERM)
    out = p.communicate(timeout=60)[0]
    return p.returncode, out.strip(), (json.loads(rec.read_text()) if rec.exists() else None)
def check(case, cond, **facts):
    global failed
    results.append({"case": case, "pass": bool(cond), **facts}); failed += not cond
    print(("[ok] " if cond else "[FAIL] ") + case + "  " + json.dumps(facts)[:500], flush=True)
def first(o): return o.splitlines()[0] if o else ""
def argv_facts(rec):
    return {"MemoryMax": next((x for x in rec if x.startswith("MemoryMax=")), None), "swap": next((x for x in rec if x.startswith("MemorySwapMax=")), None),
            "guard": rec[rec.index("--max-rss-mib") - 1], "guardMax": rec[rec.index("--max-rss-mib") + 1],
            "guardFloor": rec[rec.index("--floor-available-mib") + 1]} if rec else None

# 1 static: pins, exact diff, ROOT pinned to the shared work dir, same lock names and guard path
diff = subprocess.run(["diff", str(CURRENT), str(CAND)], capture_output=True, text=True).stdout
changed = [l for l in diff.splitlines() if l[:2] in ("< ", "> ")]
src = CAND.read_text()
check("1 pins; candidate == current except ROOT pin, MAX 6144 (+4096 choice), --extra-start-mib, its use and the START line; ROOT/locks/guard shared",
      h(CURRENT) == PINS["current"] and h(CAND) == PINS["candidate"] and h(GUARD) == PINS["guard"] and len(changed) == 17
      and f"ROOT = Path({WORK!r})" in src and "__file__" not in src
      and 'ROOT / "claude-test-queue.lock"' in src and 'ROOT / "claude-test-small-queue.lock"' in src
      and 'guard = ROOT / "enclave/test/helpers/memory-guard.mjs"' in src and "floor = 16384\n" in src
      and "    start = floor + args.mib + 256 + reserved + args.extra_start_mib\n" in src, changedLines=len(changed))
# 2 argument validation; CONTROL: current rejects 6144
c, o = clone(CAND, "c2"), clone(CURRENT, "o2")
r = [run(c, 5120, 40000)[0], run(o, 6144, 40000)[0], run(c, 256, 40000, extra=2048)[0], run(c, 6144, 40000, extra=512)[0],
     run(c, 4096, 40000)[0], run(c, 2560, 40000)[0], run(c, 6144, 40000)[0]]
check("2 args: 5120 rejected, current 6144 rejected [control], extra with 256 rejected, extra 512 rejected; 4096, 2560, 6144 start", r == [2, 2, 2, 2, 0, 0, 0], rcs=r)
# 3 large 6144, small lane idle: floor+6144+256 = 22784; nothing starts below (no child before capacity)
c = clone(CAND, "c3")
rp, op, recp = run(c, 6144, 22784, code=7); rn, on, recn = run(c, 6144, 22783)
check("3 large 6144 idle: starts at 22784 (child rc 7 propagated; argv MemoryMax=6144M swap 0, ROOT-relative guard path, 6144/16384); 22783 -> 98, no child",
      rp == 7 and "required=22784MiB cap=6144MiB" in op and argv_facts(recp) == {"MemoryMax": "MemoryMax=6144M", "swap": "MemorySwapMax=0", "guard": str(c / "enclave/test/helpers/memory-guard.mjs"), "guardMax": "6144", "guardFloor": "16384"}
      and rn == 98 and recn is None, pos=[rp, first(op)], argv=argv_facts(recp), neg=[rn, on])
# 4 extra start headroom 2048: 24832 idle
rp, op, _ = run(c, 6144, 24832, extra=2048); rn, on, recn = run(c, 6144, 24831, extra=2048)
check("4 large 6144 + extra 2048 idle: starts at 24832; 24831 -> 98, no child", rp == 0 and "required=24832MiB" in op and "extraStart=2048MiB" in op and rn == 98 and recn is None, pos=first(op), neg=[rn, on])
# 5 large 6144 while a small job holds its lane: 23040; with extra 2048: 25088
c = clone(CAND, "c5"); sl = lock(c, "small")
a = run(c, 6144, 23040); b = run(c, 6144, 23039); e1 = run(c, 6144, 25088, extra=2048); e2 = run(c, 6144, 25087, extra=2048); sl.close()
check("5 large 6144 + small held: 23040 starts (concurrentSmall=256), 23039 -> 98; with extra 2048: 25088 starts, 25087 -> 98; no child on 98",
      a[0] == 0 and "required=23040MiB" in a[1] and "concurrentSmall=256MiB" in a[1] and b[0] == 98 and b[2] is None
      and e1[0] == 0 and "required=25088MiB" in e1[1] and e2[0] == 98 and e2[2] is None, pos=[first(a[1]), first(e1[1])], neg=[b[:2], e2[:2]])
# 6 small joining an occupied large lane reserves the WHOLE 6144: 16384+256+256+6144 = 23040; CONTROL current reserves 4096 (20992)
c, o = clone(CAND, "c6"), clone(CURRENT, "o6"); mc, mo = lock(c, "main"), lock(o, "main")
a = run(c, 256, 23040); b = run(c, 256, 23039); k = run(o, 256, 20992); mc.close(); mo.close()
check("6 small + occupied large lane: candidate reserves 6144 (23040 starts, 23039 -> 98); control current reserves only 4096 (starts at 20992)",
      a[0] == 0 and "concurrentLargeReserve=6144MiB" in a[1] and "required=23040MiB" in a[1] and b[0] == 98 and b[2] is None
      and k[0] == 0 and "concurrentLargeReserve=4096MiB" in k[1], pos=first(a[1]), neg=b[:2], control=first(k[1]))
# 7 mutual exclusion across copies at DIFFERENT paths that share one ROOT (a moved copy is the same queue)
S = T / "shared-root"; S.mkdir(); dA, dB, dC = clone(CAND, "c7a", S), clone(CAND, "c7b", S), clone(CAND, "c7c", S)
pa, ra = start(dA, 6144, 40000, sleep=8); okA = started(ra)
b = run(dB, 6144, 40000)                                 # second large from another path: lane held -> 98
ps, rs = start(dB, 256, 40000, sleep=4); okS = started(rs)  # small joins the running large lane with the whole reserve
c3 = run(dC, 256, 40000)                                 # second small from a third path: small lane held -> 98
outS = ps.communicate(timeout=30)[0]; outA = pa.communicate(timeout=30)[0]
check("7 copies in 3 directories with one ROOT: large A runs; large B -> 98 (lane held, no child); small B joins with concurrentLargeReserve=6144; small C -> 98",
      okA and b[0] == 98 and b[2] is None and "test allocation held" in b[1] and okS and "concurrentLargeReserve=6144MiB" in outS
      and c3[0] == 98 and c3[2] is None and "small allocation held" in c3[1] and pa.returncode == 0 and ps.returncode == 0,
      largeB=b[:2], smallB=first(outS), smallC=c3[:2])
# 8 SIGTERM during a running 6144 allocation: 143 and the exact child is gone
c = clone(CAND, "c8"); rc, out, rec = run(c, 6144, 22784, sleep=30, term=True)
pid = int((c / "rec.json.pid").read_text()); end = time.monotonic() + 3
def alive():
    try: return Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()[0] != "Z"
    except OSError: return False
while alive() and time.monotonic() < end: time.sleep(0.1)
check("8 SIGTERM during a 6144 job: queue exits 143 and its exact child is gone", rc == 143 and rec is not None and not alive(), rc=rc, childPid=pid)
# 9 the REAL memory guard (unchanged file) still enforces its floor and cap, and propagates exit codes (tiny children only)
def guard(maxr, floor, code=0, sleep=5):
    lg = T / f"guard-{maxr}-{floor}.log"
    r = subprocess.run(["node", str(GUARD), "--max-rss-mib", str(maxr), "--floor-available-mib", str(floor), "--log", str(lg), "--",
                        sys.executable, "-c", f"import time,sys; time.sleep({sleep}); sys.exit({code})"], capture_output=True, text=True, timeout=60)
    return r.returncode, r.stderr
fl = guard(6144, 10**9); cp = guard(1, 0); ok = guard(6144, 0, code=7, sleep=0)
check("9 real guard: floor above any host -> 99 'below floor'; cap 1 MiB -> 99 'tree RSS'; within limits child rc 7 propagated",
      fl[0] == 99 and "< floor 1000000000 MiB" in fl[1] and cp[0] == 99 and "> 1 MiB" in cp[1] and ok[0] == 7, floor=fl[0], cap=cp[0], ok=ok[0])
subprocess.run(["rm", "-rf", str(T)])
print(json.dumps({"result": "pass" if not failed else "FAIL", "failed": failed, "cases": results}, indent=1))
sys.exit(1 if failed else 0)
