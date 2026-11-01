#!/usr/bin/env python3
"""Actual PID1 guardian in disposable namespaces; no VM, mounts of data or mocked reboot.
Run once inside an independently bounded controller allocation. The separately
compiled test fixture refuses the initial user namespace even when run as root.
"""
import array
import hashlib
import json
import os
from pathlib import Path
import select
import signal
import socket
import struct
import subprocess
import sys
import time


def dead(fd):
    poll = select.poll(); poll.register(fd, select.POLLIN)
    return bool(poll.poll(0))


def exact_pid(fd):
    for line in Path(f"/proc/self/fdinfo/{fd}").read_text().splitlines():
        if line.startswith("Pid:"): return int(line.split()[1])
    raise AssertionError("missing exact kernel pidfd identity")


def check_shutdown(mode, status):
    # Linux PID-namespace POWER_OFF becomes SIGINT; bwrap exposes128+SIGINT.
    # A failed reboot followed by our fallback _exit(125) must NOT pass.
    expected = 72 if mode in ("future", "overflow", "expired") else (137 if mode == "guardian-loss" else 130)
    assert status == expected, ("unexpected shutdown path", mode, status, expected)


def case(binary, mode, left):
    parent, child = socket.socketpair(socket.AF_UNIX, socket.SOCK_SEQPACKET)
    parent.settimeout(2)
    command = ["/usr/bin/bwrap", "--unshare-all", "--as-pid-1", "--die-with-parent", "--new-session",
               "--clearenv", "--uid", "0", "--gid", "0", "--cap-add", "CAP_SYS_BOOT",
               "--ro-bind", str(binary), "/fixture", "--proc", "/proc", "--dev", "/dev",
               "/fixture", mode, str(left)]
    start = time.monotonic_ns()
    process = subprocess.Popen(command, stdin=child, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    child.close(); held = {}; observations = {}; origin = deadline = None
    try:
        wanted = {"G"} if mode in ("future", "overflow", "expired") else {"G", "W"}
        if mode in ("exec-deadline", "guardian-loss"): wanted |= {"E", "D"}
        while set(held) != wanted or deadline is None:
            data, ancillary, flags, _ = parent.recvmsg(128, socket.CMSG_SPACE(4))
            assert data and not flags & (socket.MSG_TRUNC | socket.MSG_CTRUNC), "truncated child evidence"
            if len(data) == 16:
                assert not ancillary and deadline is None
                origin, deadline = struct.unpack("=QQ", data); continue
            assert len(data) == 1 and len(ancillary) == 1
            level, kind, raw = ancillary[0]
            assert level == socket.SOL_SOCKET and kind == socket.SCM_RIGHTS and len(raw) == 4
            fd = array.array("i"); fd.frombytes(raw); role = data.decode()
            assert role in wanted and role not in held
            held[role] = fd[0]; observations[role] = {"pid": exact_pid(fd[0]), "observedNs": time.monotonic_ns()}
        invalid = mode in ("future", "overflow", "expired")
        limits = None
        if not invalid:
            limits = Path(f"/proc/{observations['G']['pid']}/limits").read_text()
            addr = next(x for x in limits.splitlines() if x.startswith("Max address space")).split()
            core = next(x for x in limits.splitlines() if x.startswith("Max core file size")).split()
            assert int(addr[-3]) <= 32 << 20 and int(addr[-2]) <= 32 << 20
            assert core[-3:-1] == ["0", "0"]
            assert observations["G"]["pid"] != observations["W"]["pid"]
            assert deadline == origin + 900_000_000_000 and time.monotonic_ns() < deadline
        if mode == "exec-deadline":
            assert observations["W"]["pid"] == observations["E"]["pid"]
            signal.pidfd_send_signal(held["W"], signal.SIGSTOP)
        signaled = None
        if mode == "guardian-loss":
            signaled = time.monotonic_ns()
            signal.pidfd_send_signal(held["G"], signal.SIGKILL)
        wait_by = time.monotonic() + 2
        while not all(dead(fd) for fd in held.values()):
            assert time.monotonic() < wait_by, "exact actors still alive"
            time.sleep(.002)
        terminal = time.monotonic_ns()
        out, err = process.communicate(timeout=2)
        check_shutdown(mode, process.returncode)
        if invalid:
            assert process.returncode == 72, (mode, process.returncode, out, err)
        elif mode in ("blocked-preparation", "exec-deadline"):
            assert terminal >= deadline and terminal <= deadline + 500_000_000, "original deadline changed"
        else:
            assert terminal < deadline, "waited for natural deadline"
            if mode == "guardian-loss": assert terminal - signaled < 500_000_000
        return {"mode": mode, "originalOriginNs": origin, "originalDeadlineNs": deadline,
                "actors": observations, "allExactHandlesDeadNs": terminal, "signalNs": signaled,
                "elapsedNs": terminal - start, "returncode": process.returncode,
                "stdout": out.decode(), "stderr": err.decode(), "guardianLimits": limits,
                "rebootMocked": False, "productionGuest": False}
    finally:
        parent.close()
        # Exact known child controller only; on failure retain evidence and end
        # this private namespace under the independently bounded outer unit.
        if process.poll() is None: process.kill(); process.wait(timeout=2)
        for fd in held.values(): os.close(fd)


def main():
    binary = Path(sys.argv[1]).resolve(); output = Path(sys.argv[2])
    digest = hashlib.sha256(binary.read_bytes()).hexdigest()
    with output.open("x") as log:
        for mode, left in (("blocked-preparation", 500), ("exec-deadline", 800),
                           ("early-exit", 5000), ("guardian-loss", 5000),
                           ("future", 500), ("overflow", 500), ("expired", 500)):
            row = case(binary, mode, left)
            log.write(json.dumps(row) + "\n"); log.flush(); os.fsync(log.fileno())
            print(json.dumps({"mode": mode, "pass": True, "elapsedNs": row["elapsedNs"],
                              "actors": len(row["actors"])}), flush=True)
    assert hashlib.sha256(binary.read_bytes()).hexdigest() == digest


if __name__ == "__main__": main()
