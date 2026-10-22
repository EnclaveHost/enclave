#!/usr/bin/env python3
"""One large allocation plus one 256 MiB allocation, preserving the 16 GiB reserve.

python3 work/claude-test-queue.py --mib 512 --log work/job.guard.log -- command args...
Exit 98 means no job started (queue or capacity unavailable after 60 seconds).
The coordinator grants each workstream its own cap; this helper does not enlarge it.
"""
import argparse
import fcntl
import os
from pathlib import Path
import signal
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parent
parser = argparse.ArgumentParser()
parser.add_argument("--mib", type=int, required=True, choices=[256, 512, 768, 1024, 1408, 1536])
parser.add_argument("--log", required=True)
parser.add_argument("command", nargs=argparse.REMAINDER)
args = parser.parse_args()
cmd = args.command[1:] if args.command[:1] == ["--"] else args.command
if not cmd:
    parser.error("command required")

lock = open(ROOT / "claude-test-queue.lock", "a+")
small_lock = open(ROOT / "claude-test-small-queue.lock", "a+")
small = args.mib == 256
owns_main_lock = False
if small:
    # Reserve this lane before checking the main lane. A concurrently starting
    # large job then includes the entire small allocation in its admission check.
    try:
        fcntl.flock(small_lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        print("[queue] NOT STARTED: small allocation held", flush=True)
        sys.exit(98)

deadline = time.monotonic() + 60
while True:
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        owns_main_lock = True
        break
    except BlockingIOError:
        if small:
            # A large job is already running or checking capacity. Admit one
            # small job only while reserving the MAXIMUM possible large budget,
            # in addition to its own cap and host headroom. No PID/lock-owner
            # inference is needed, and replacement large jobs stay covered.
            break
        if time.monotonic() >= deadline:
            print("[queue] NOT STARTED: test allocation held", flush=True)
            sys.exit(98)
        time.sleep(1)

def small_reservation():
    if small:
        return 0
    try:
        fcntl.flock(small_lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        return 256
    fcntl.flock(small_lock, fcntl.LOCK_UN)
    return 0

floor = 16384
# Reserve the WHOLE concurrent small allocation, even though its existing RSS
# already reduces MemAvailable. Keep another 256 MiB for host variation.
# A small job joining an occupied large lane reserves its maximum 1536 MiB,
# even though the running large job's RSS already reduces MemAvailable.
while True:
    # A large request must own the lane for its admission snapshot, but must not
    # monopolize the lane while it cannot fit. Reacquire before every decision.
    if not small and not owns_main_lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            if time.monotonic() >= deadline:
                print("[queue] NOT STARTED: test allocation held", flush=True)
                sys.exit(98)
            time.sleep(1)
            continue
        owns_main_lock = True
    # A small job may have arrived while a large job owned the main lane, then
    # waited for headroom after that job ended. Reacquire the now-free lane
    # before accounting exactly as an initially idle main lane. The exclusive
    # lock prevents another large job starting during admission; the small lock
    # remains held through execution, so the next large job reserves its full
    # 256 MiB. Floors and budgets are unchanged.
    if small and not owns_main_lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            pass
        else:
            owns_main_lock = True
    reserved = 1536 if small and not owns_main_lock else small_reservation()
    start = floor + args.mib + 256 + reserved
    available = next(int(l.split()[1]) // 1024 for l in Path("/proc/meminfo").read_text().splitlines() if l.startswith("MemAvailable:"))
    # If a small job has already reserved its lane, let it enter first when
    # admitting this large job would make its conservative concurrent admission
    # impossible. A running small job finishes quickly; a waiting one can now
    # acquire the released main lane. This is scheduling only: the same floors,
    # full caps and reservations apply before any child is started.
    if not small and reserved and available < floor + 1536 + 256 + 256:
        fcntl.flock(lock, fcntl.LOCK_UN)
        owns_main_lock = False
        if time.monotonic() >= deadline:
            print("[queue] NOT STARTED: yielding to reserved small allocation", flush=True)
            sys.exit(98)
        time.sleep(1)
        continue
    if available >= start:
        break
    if time.monotonic() >= deadline:
        print(f"[queue] NOT STARTED: available={available}MiB required={start}MiB cap={args.mib}MiB", flush=True)
        sys.exit(98)
    # No child exists yet. Yield the lane so a smaller allocation that fits can
    # run. Active jobs retain their locks and all admission budgets are unchanged.
    if owns_main_lock:
        fcntl.flock(lock, fcntl.LOCK_UN)
        owns_main_lock = False
    time.sleep(1)

guard = ROOT / "enclave/test/helpers/memory-guard.mjs"
lane = "concurrentLargeReserve" if small and not owns_main_lock else "concurrentSmall"
print(f"[queue] START available={available}MiB required={start}MiB cap={args.mib}MiB floor={floor}MiB {lane}={reserved}MiB", flush=True)
child = subprocess.Popen([
    "systemd-run", "--user", "--scope", "--quiet",
    "-p", f"MemoryMax={args.mib}M", "-p", "MemorySwapMax=0",
    "node", str(guard), "--max-rss-mib", str(args.mib),
    "--floor-available-mib", str(floor), "--log", str(Path(args.log).resolve()),
    "--", *cmd
], start_new_session=True)
def stop(signum, _frame):
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
    signal.signal(signal.SIGINT, signal.SIG_IGN)
    # Stop only this allocation's descendants. The coordinator and other workers
    # remain untouched; keep the queue lock held until cleanup is complete.
    parents = {}
    for p in Path("/proc").iterdir():
        if not p.name.isdigit():
            continue
        try:
            st = (p / "stat").read_text()
            parents[int(p.name)] = int(st[st.rfind(")") + 2:].split()[1])
        except (OSError, ValueError):
            pass
    owned = {child.pid}
    while True:
        expanded = owned | {p for p, pp in parents.items() if pp in owned}
        if expanded == owned:
            break
        owned = expanded
    for sig in (signal.SIGTERM, signal.SIGKILL):
        for p in owned:
            try:
                os.kill(p, sig)
            except ProcessLookupError:
                pass
        if sig == signal.SIGTERM:
            time.sleep(1)
    # Never re-enter Popen.wait() here: this handler may have interrupted that
    # same wait while its internal lock was held. Raising unwinds the original
    # wait and releases our file locks; the terminated child is then reaped.
    raise SystemExit(128 + signum)

signal.signal(signal.SIGTERM, stop)
signal.signal(signal.SIGINT, stop)
if small and owns_main_lock:
    # Keep the small-lane descriptor locked until the guarded job exits. The
    # next large job must reserve this lane's full cap before it may start.
    fcntl.flock(lock, fcntl.LOCK_UN)
rc = child.wait()
print(f"[queue] EXIT {rc}", flush=True)
sys.exit(rc if rc >= 0 else 128 - rc)
