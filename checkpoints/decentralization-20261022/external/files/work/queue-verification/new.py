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

ROOT = Path('/home/steven/Documents/Codex/2026-10-18/wo/work')
parser = argparse.ArgumentParser()
parser.add_argument("--mib", type=int, required=True, choices=[256, 512, 768, 1024, 1408, 1536])
parser.add_argument("--log", required=True)
parser.add_argument("command", nargs=argparse.REMAINDER)
args = parser.parse_args()
cmd = args.command[1:] if args.command[:1] == ["--"] else args.command
if not cmd:
    parser.error("command required")

lock = open(ROOT / 'queue-verification/new-main.lock', "a+")
small_lock = open(ROOT / 'queue-verification/new-small.lock', "a+")
deadline = time.monotonic() + 60
while True:
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        break
    except BlockingIOError:
        if time.monotonic() >= deadline:
            print("[queue] NOT STARTED: test allocation held", flush=True)
            sys.exit(98)
        time.sleep(1)

small = args.mib == 256
if small:
    try:
        fcntl.flock(small_lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        print("[queue] NOT STARTED: small allocation held", flush=True)
        sys.exit(98)

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
# A new small job cannot start while a large job owns the main lock.
while True:
    reserved = small_reservation()
    start = floor + args.mib + 256 + reserved
    available = next(int(l.split()[1]) // 1024 for l in Path("/proc/meminfo").read_text().splitlines() if l.startswith("MemAvailable:"))
    if available >= start:
        break
    if time.monotonic() >= deadline:
        print(f"[queue] NOT STARTED: available={available}MiB required={start}MiB cap={args.mib}MiB", flush=True)
        sys.exit(98)
    time.sleep(1)

guard = ROOT / "enclave/test/helpers/memory-guard.mjs"
print(f"[queue] START available={available}MiB required={start}MiB cap={args.mib}MiB floor={floor}MiB concurrentSmall={reserved}MiB", flush=True)
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
if small:
    # Keep the small-lane descriptor locked until the guarded job exits. The
    # next large job must reserve this lane's full cap before it may start.
    fcntl.flock(lock, fcntl.LOCK_UN)
rc = child.wait()
print(f"[queue] EXIT {rc}", flush=True)
sys.exit(rc if rc >= 0 else 128 - rc)
