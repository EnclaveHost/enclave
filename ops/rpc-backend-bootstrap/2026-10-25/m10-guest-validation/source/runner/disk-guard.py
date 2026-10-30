#!/usr/bin/env python3
"""Run ONE command in its own process group; stop ONLY that group if free space on PATH falls below the floor.
  disk-guard.py --path DIR --floor-mib N [--log FILE] -- command args...
Before starting: PATH must exist (else exit 2, nothing started) and be above the floor (else exit 97, nothing started).
Every 2 s: statvfs(PATH).f_bavail. Below the floor: stop the group, exit 97. SIGTERM/SIGINT to this guard: stop the group,
exit 143/130. When the command exits by itself, any process it left in its group is stopped too, and its own exit code is
returned (a signal death as 128+N). "Stop the group" = SIGTERM to the group, up to 5 s for it to vanish, then SIGKILL.
Only this command's process group is ever signalled. Nothing is deleted: partial builds, outputs and logs are preserved."""
import os, signal, subprocess, sys, time
a = sys.argv[1:]; sep = a.index("--"); opt = dict(zip(a[:sep:2], a[1:sep:2])); cmd = a[sep + 1:]
path, floor, log = opt["--path"], int(opt["--floor-mib"]), opt.get("--log")
def note(m):
    print(m, file=sys.stderr, flush=True)
    if log:
        with open(log, "a") as f: f.write(m + "\n")
def free():
    s = os.statvfs(path); return s.f_bavail * s.f_frsize // 1048576
if not cmd: note("[disk-guard] NOT STARTED: no command"); sys.exit(2)
try: f0 = free()
except OSError as e: note(f"[disk-guard] NOT STARTED: cannot stat {path}: {e}"); sys.exit(2)
if f0 < floor: note(f"[disk-guard] NOT STARTED: {path} free {f0} MiB < floor {floor} MiB"); sys.exit(97)
got = []
def on_signal(signum, _frame): got.append(signum)
signal.signal(signal.SIGTERM, on_signal); signal.signal(signal.SIGINT, on_signal)
p = subprocess.Popen(cmd, start_new_session=True); pg = p.pid
def group_alive():
    try: os.killpg(pg, 0); return True
    except ProcessLookupError: return False
    except PermissionError: return True
def stop_group():
    for sig in (signal.SIGTERM, signal.SIGKILL):
        try: os.killpg(pg, sig)
        except ProcessLookupError: return
        end = time.monotonic() + 5
        while time.monotonic() < end:
            try: p.wait(0.1)
            except subprocess.TimeoutExpired: pass
            if p.poll() is not None and not group_alive(): return
low = None; mn = f0
while p.poll() is None and not got and low is None:
    try: f = free()
    except OSError as e: note(f"[disk-guard] cannot stat {path}: {e}"); f = -1
    mn = min(mn, f)
    if f < floor: low = f; note(f"[disk-guard] STOPPING own job: {path} free {f} MiB < floor {floor} MiB")
    else:
        try: p.wait(2)
        except subprocess.TimeoutExpired: pass
if got: note(f"[disk-guard] STOPPING own job: received signal {got[0]}")
stop_group()                                     # also removes anything the command left behind in its group
rc = p.wait(); rc = 128 - rc if rc < 0 else rc
final = 97 if low is not None else (128 + got[0] if got else rc)
note(f"[disk-guard] exit={final} childExit={rc} minFreeMiB={mn}" + (f" STOPPED: free {low} MiB < floor {floor} MiB" if low is not None else "") + (f" STOPPED: signal {got[0]}" if got else ""))
sys.exit(final)
