#!/usr/bin/env python3
"""Tiny isolated tests of runner/disk-guard.py (PREPARED; root runs them, e.g. inside the shared queue at 256 MiB):
  python3 work/claude-test-queue.py --mib 256 --log $G/logs/test-disk-guard.guard -- python3 $G/test-disk-guard.py
Only `sleep`/`bash` children and a private temp dir; no large memory, no native build. The below-floor-during-run case uses
a test-only clone whose free() reads a fixture file (the ONLY substitution); every other case runs the real guard."""
import hashlib, json, os, signal, subprocess, sys, tempfile, time
from pathlib import Path
HERE = Path(__file__).resolve().parent; G = HERE / "runner/disk-guard.py"
PIN = "40e6d0cc1169e8054cbefba6cc19bd6b3028dbfb8ba367dae53a384b905f33c3"
T = Path(tempfile.mkdtemp(prefix="dg-", dir=HERE)); res = []; failed = 0
def check(name, cond, **facts):
    global failed
    res.append({"case": name, "pass": bool(cond), **facts}); failed += not cond
    print(("[ok] " if cond else "[FAIL] ") + name + "  " + json.dumps(facts)[:300], flush=True)
def alive(pid):
    try: return Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()[0] != "Z"
    except OSError: return False
def wait_gone(*pids, t=8):
    end = time.monotonic() + t
    while any(alive(p) for p in pids) and time.monotonic() < end: time.sleep(0.1)
    return not any(alive(p) for p in pids)
def wait_file(f, t=10):
    end = time.monotonic() + t
    while not (f.exists() and f.read_text().strip()) and time.monotonic() < end: time.sleep(0.05)
    return f.exists()
def guard(script, *cmd, floor=1, path=None, env=None):
    return subprocess.Popen([sys.executable, str(script), "--path", str(path or T), "--floor-mib", str(floor), "--log", str(T / "dg.log"), "--", *cmd],
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, env=env)
# family: child bash writes its pid and a grandchild sleep's pid, writes an output file, then sleeps
FAM = 'echo $$ > "$1/child.pid"; sleep 300 & echo $! > "$1/gc.pid"; echo kept > "$1/output.txt"; sleep 300'
check("0 pin", hashlib.sha256(G.read_bytes()).hexdigest() == PIN)
unrelated = subprocess.Popen(["sleep", "300"], start_new_session=True)
# 1 missing path: refused before any child (exit 2, marker never written)
mk = T / "should-not-exist"; p = guard(G, "bash", "-c", f'touch "{mk}"', path=T / "missing-dir"); o = p.communicate(timeout=20)[0]
check("1 missing path: exit 2 before any child", p.returncode == 2 and not mk.exists() and "NOT STARTED" in o, rc=p.returncode)
# 2 floor above free space at start: exit 97 before any child
p = guard(G, "bash", "-c", f'touch "{mk}"', floor=10**12); o = p.communicate(timeout=20)[0]
check("2 below floor at start: exit 97 before any child", p.returncode == 97 and not mk.exists(), rc=p.returncode)
# 3 child exit codes propagate (0 and 7)
r = []
for c in (0, 7):
    p = guard(G, "bash", "-c", f"exit {c}"); p.communicate(timeout=20); r.append(p.returncode)
check("3 child rc propagated (0, 7)", r == [0, 7], rcs=r)
# 4/5 SIGTERM and SIGINT to the guard: 143/130, child AND grandchild gone, output preserved
for n, sig, want in ((4, signal.SIGTERM, 143), (5, signal.SIGINT, 130)):
    d = T / f"s{n}"; d.mkdir(); p = guard(G, "bash", "-c", FAM, "fam", str(d))
    okf = wait_file(d / "gc.pid") and wait_file(d / "child.pid"); time.sleep(0.3)
    ch, gc = int((d / "child.pid").read_text()), int((d / "gc.pid").read_text())
    p.send_signal(sig); p.communicate(timeout=30)
    check(f"{n} {sig.name}: guard exits {want}, child + grandchild gone, output kept",
          okf and p.returncode == want and wait_gone(ch, gc) and (d / "output.txt").read_text() == "kept\n", rc=p.returncode)
# 6 child exits early leaving a grandchild in its group: child's rc returned and the leftover grandchild stopped
d = T / "s6"; d.mkdir(); p = guard(G, "bash", "-c", 'sleep 300 & echo $! > "$1/gc.pid"; exit 5', "fam", str(d)); p.communicate(timeout=30)
gc = int((d / "gc.pid").read_text())
check("6 early child exit: rc 5 returned and the leftover grandchild is stopped", p.returncode == 5 and wait_gone(gc), rc=p.returncode)
# 7 free space falls below the floor DURING the run (test-only clone: free() reads a fixture): 97, family gone, output kept
src = G.read_text(); a = "    s = os.statvfs(path); return s.f_bavail * s.f_frsize // 1048576\n"; assert src.count(a) == 1
clone = T / "dg-clone.py"; clone.write_text(src.replace(a, '    os.stat(path); return int(open(os.environ["DG_FREE"]).read())\n'))
fx = T / "free"; fx.write_text("50000"); d = T / "s7"; d.mkdir()
p = guard(clone, "bash", "-c", FAM, "fam", str(d), floor=8192, env=dict(os.environ, DG_FREE=str(fx)))
okf = wait_file(d / "gc.pid") and wait_file(d / "child.pid"); ch, gc = int((d / "child.pid").read_text()), int((d / "gc.pid").read_text())
fx.write_text("100"); o = p.communicate(timeout=30)[0]
check("7 below floor during the run: 97, child + grandchild gone, output kept",
      okf and p.returncode == 97 and wait_gone(ch, gc) and (d / "output.txt").exists() and "free 100 MiB < floor 8192 MiB" in o, rc=p.returncode)
# 8 the unrelated process (own session, started before every case) survived all of the above
check("8 unrelated process survives every guard stop", alive(unrelated.pid), pid=unrelated.pid)
unrelated.kill(); unrelated.wait()
subprocess.run(["rm", "-rf", str(T)])
print(json.dumps({"result": "pass" if not failed else "FAIL", "failed": failed, "cases": res}, indent=1)); sys.exit(1 if failed else 0)
