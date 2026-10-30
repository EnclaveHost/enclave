#!/usr/bin/env python3
"""Admission tests of the 2560 MiB queue candidate against the CURRENT queue (b7de4344) as negative control.
Run INSIDE the current queue at 256 MiB:  python3 work/claude-test-queue.py --mib 256 --log G -- python3 test-queue-candidate.py
Test-only clones (never installed): private lock files in a temp dir, MemAvailable read from a fixture file, the 60 s
admission deadline shortened to 2 s, and `systemd-run` replaced by a stub that records its argv and runs only the tiny
child. So: the queue's admission arithmetic, lanes, exit codes, argv and signal handling are exercised for real; the
kernel cgroup limit and memory-guard enforcement at 2560 MiB are NOT (no real 2560 MiB scope is created)."""
import fcntl, hashlib, json, os, signal, subprocess, sys, tempfile, time
from pathlib import Path
HERE = Path(__file__).resolve().parent
CURRENT = Path("/home/steven/Documents/Codex/2026-10-18/wo/work/claude-test-queue.py")
CAND = HERE / "claude-test-queue.candidate.py"
PINS = {"current": "b7de4344154fdd9f4e000059cc0d130426e67d5a34474cc714407c2f7e656c00",
        "candidate": "5f752320e19ab092a0a320610ff1435ca90edf31f1fa086aed77f460d7bb58ce"}
T = Path(tempfile.mkdtemp(prefix="qtest-", dir=HERE)); results = []; failed = 0
STUB = T / "systemd-run"
STUB.write_text("#!/usr/bin/env python3\nimport json,os,sys\nopen(os.environ['QT_RECORD']+'.pid','w').write(str(os.getpid()))\nopen(os.environ['QT_RECORD'],'w').write(json.dumps(sys.argv[1:]))\n"
                "a=sys.argv[1:]; c=a[a.index('--')+1:]; os.execvp(c[0], c)\n"); STUB.chmod(0o755)
def h(p): return hashlib.sha256(Path(p).read_bytes()).hexdigest()
def clone(src, name):
    d = T / name; d.mkdir(); s = Path(src).read_text()
    for a, b in [('ROOT = Path(__file__).resolve().parent', f'ROOT = Path({str(d)!r})'),
                 ('Path("/proc/meminfo")', 'Path(os.environ["QT_MEMINFO"])'),
                 ('deadline = time.monotonic() + 60', 'deadline = time.monotonic() + 2'),
                 ('"systemd-run", "--user"', f'{str(STUB)!r}, "--user"')]:
        assert s.count(a) == 1, (name, a); s = s.replace(a, b)
    (d / "q.py").write_text(s); return d
def lock(d, which):
    f = open(d / ("claude-test-queue.lock" if which == "main" else "claude-test-small-queue.lock"), "a+")
    fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB); return f
def run(d, mib, avail, code=0, sleep=0.0, term=False):
    mi = d / "meminfo"; mi.write_text(f"MemAvailable:   {avail * 1024} kB\n"); rec = d / "rec.json"; rec.unlink(missing_ok=True)
    env = dict(os.environ, QT_MEMINFO=str(mi), QT_RECORD=str(rec))
    p = subprocess.Popen([sys.executable, str(d / "q.py"), "--mib", str(mib), "--log", str(d / "g.log"), "--",
                          sys.executable, "-c", f"import time,sys; time.sleep({sleep}); sys.exit({code})"],
                         stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, env=env)
    if term:
        end = time.monotonic() + 10
        while not rec.exists() and time.monotonic() < end: time.sleep(0.05)
        time.sleep(0.3); p.send_signal(signal.SIGTERM)
    out = p.communicate(timeout=30)[0]
    return p.returncode, out.strip(), (json.loads(rec.read_text()) if rec.exists() else None)
def check(case, cond, **facts):
    global failed
    results.append({"case": case, "pass": bool(cond), **facts}); failed += not cond
    print(("[ok] " if cond else "[FAIL] ") + case + "  " + json.dumps(facts)[:400], flush=True)
def argv_facts(rec):
    return {"MemoryMax": next((x for x in rec if x.startswith("MemoryMax=")), None),
            "swap": next((x for x in rec if x.startswith("MemorySwapMax=")), None),
            "guardMax": rec[rec.index("--max-rss-mib") + 1], "guardFloor": rec[rec.index("--floor-available-mib") + 1]} if rec else None

# 1 metadata: pins and an exactly-two-line diff
diff = subprocess.run(["diff", str(CURRENT), str(CAND)], capture_output=True, text=True).stdout
changed = [l for l in diff.splitlines() if l[:2] in ("< ", "> ")]
check("1 pins + candidate differs only in MAX_LARGE_MIB and the --mib choices", h(CURRENT) == PINS["current"] and h(CAND) == PINS["candidate"]
      and changed == ["< MAX_LARGE_MIB = 1792", "> MAX_LARGE_MIB = 2560",
                      '< parser.add_argument("--mib", type=int, required=True, choices=[256, 512, 768, 1024, 1408, 1536, MAX_LARGE_MIB])',
                      '> parser.add_argument("--mib", type=int, required=True, choices=[256, 512, 768, 1024, 1408, 1536, 1792, MAX_LARGE_MIB])'],
      current=h(CURRENT), candidate=h(CAND))
# 2 cap choices: candidate accepts 2560 and still 1792, rejects 2048; CONTROL: current rejects 2560
c, o = clone(CAND, "c2"), clone(CURRENT, "o2")
r = [run(c, 2048, 30000)[0], run(o, 2560, 30000)[0], run(c, 1792, 30000)[0], run(c, 2560, 30000)[0]]
check("2 caps: candidate 2048 rejected (2), current 2560 rejected (2) [control], candidate 1792 and 2560 start", r == [2, 2, 0, 0], rcs=r)
# 3 large 2560, small lane idle: needs floor+2560+256 = 19200
c = clone(CAND, "c3")
rp, op, recp = run(c, 2560, 19200, code=7); rn, on, recn = run(c, 2560, 19199)
check("3 large 2560 alone: starts at 19200 (child rc 7 propagated, stub argv caps 2560/16384); NOT at 19199 (98, nothing started)",
      rp == 7 and "required=19200MiB cap=2560MiB" in op and argv_facts(recp) == {"MemoryMax": "MemoryMax=2560M", "swap": "MemorySwapMax=0", "guardMax": "2560", "guardFloor": "16384"}
      and rn == 98 and recn is None, pos=[rp, op.splitlines()[0]], argv=argv_facts(recp), neg=[rn, on])
# 4 large 2560 while a small job holds its lane: 16384+2560+256+256 = 19456
c = clone(CAND, "c4"); sl = lock(c, "small")
rp, op, recp = run(c, 2560, 19456); rn, on, recn = run(c, 2560, 19455); sl.close()
check("4 large 2560 + small held: starts at 19456 with concurrentSmall=256; NOT at 19455 (98)",
      rp == 0 and "required=19456MiB" in op and "concurrentSmall=256MiB" in op and rn == 98 and recn is None, pos=op.splitlines()[0], neg=[rn, on])
# 5 small joining an occupied large lane: 16384+256+256+2560 = 19456; CONTROL: current reserves only 1792 (starts at 18688)
c, o = clone(CAND, "c5"), clone(CURRENT, "o5"); mc, mo = lock(c, "main"), lock(o, "main")
rp, op, _ = run(c, 256, 19456); rn, on, recn = run(c, 256, 19455); ro, oo, _ = run(o, 256, 18688); mc.close(); mo.close()
check("5 small + large lane occupied: candidate reserves 2560 (starts 19456, NOT 19455); control current reserves 1792 (starts at 18688 = under-reserves a 2560 job)",
      rp == 0 and "required=19456MiB" in op and "concurrentLargeReserve=2560MiB" in op and rn == 98 and recn is None
      and ro == 0 and "concurrentLargeReserve=1792MiB" in oo, pos=op.splitlines()[0], neg=[rn, on], control=oo.splitlines()[0])
# 6 second small while the small lane is held: immediate 98 (both)
c, o = clone(CAND, "c6"), clone(CURRENT, "o6"); s1, s2 = lock(c, "small"), lock(o, "small")
a, b = run(c, 256, 30000), run(o, 256, 30000); s1.close(); s2.close()
check("6 second small allocation refused (98, nothing started) in candidate and current", a[0] == 98 and b[0] == 98 and a[2] is None and "small allocation held" in a[1], cand=a[:2], cur=b[:2])
# 7 behaviour change for 1792 jobs: alone unchanged (18432); with a small held the yield threshold rises 18688 -> 19456
c, o = clone(CAND, "c7"), clone(CURRENT, "o7")
alone = run(c, 1792, 18432)[0]; sc, so = lock(c, "small"), lock(o, "small")
cy = run(c, 1792, 19455); oy = run(o, 1792, 19455); sc.close(); so.close()
check("7 large 1792: alone starts at 18432 (unchanged); with small held candidate YIELDS at 19455 (98) where current starts [documented change]",
      alone == 0 and cy[0] == 98 and "yielding" in cy[1] and oy[0] == 0, alone=alone, cand=cy[:2], cur=oy[1].splitlines()[0])
# 8 SIGTERM of a running 2560 allocation: 143, child gone
c = clone(CAND, "c8"); rc, out, rec = run(c, 2560, 19200, sleep=30, term=True)
pid = int((c / "rec.json.pid").read_text()); end = time.monotonic() + 3
def alive():   # the exact child the stub exec'd (pid recorded before exec); a reaped or zombie child counts as gone
    try: return Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()[0] != "Z"
    except OSError: return False
while alive() and time.monotonic() < end: time.sleep(0.1)
check("8 SIGTERM during a 2560 job: queue exits 143 and its exact child is gone", rc == 143 and rec is not None and not alive(), rc=rc, childPid=pid, childAlive=alive())
subprocess.run(["rm", "-rf", str(T)])
print(json.dumps({"result": "pass" if not failed else "FAIL", "failed": failed, "cases": results}, indent=1))
sys.exit(1 if failed else 0)
