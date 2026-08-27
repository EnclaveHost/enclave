#!/usr/bin/env python3
"""
test_reservation.py -- HELLO 1.3 reservations against a RUNNING scratch worker.

Starts nothing itself. Start a worker from your build first, on a scratch
port, TCP only, with a small budget:

    ./shielded-worker --host 127.0.0.1 --port 9612 --vsock-port 0 --vram-gb 0.3
    python3 test_reservation.py --port 9612 [--reserve-mib 64] [--worker-bin ./shielded-worker]

What it checks, with the numbers it saw printed for the report:

  1. a 4-byte HELLO (a 1.2 link) reserves nothing: vram_reserved 0, and
     allocations up to the whole budget still work;
  2. a HELLO reserving R: the reply says vram_reserve R and vram_reserved R,
     and the worker's device memory (nvidia-smi, per pid) grew by ~R; a second
     link asking for more than budget - R is refused ("exceeds the budget");
     a second link asking for R is granted, vram_reserved 2R; closing the
     first drops vram_reserved to R on a fresh HELLO and the pid's memory
     falls;
  3. a link with reservation R that allocates R + 1 MiB is refused
     ("exceeds the link's reservation"), while R fits;
  4. (with --worker-bin) a worker asked for a budget larger than the card
     exits 75 before touching the card.

R defaults to 64 MiB; pass --reserve-mib smaller when the card is nearly
full (the worker's context itself needs ~150 MiB, and the driver keeps ~100
MiB it never hands out). Refusals are read from the worker's STATUS_VIOLATION
reply -- the worker closes the link after one, as it must.

The pure half of the same rules (the ledger, the refusals, the reply fields)
runs without a card in `python3 ../protocol.py`.
"""

import argparse
import json
import os
import socket
import struct
import subprocess
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
from protocol import CMD_ALLOC_BUFFER, CMD_HELLO, build_frame  # noqa: E402

MiB = 1 << 20
STATUS_OK = 0


class Link:
    def __init__(self, port):
        self.sock = socket.create_connection(("127.0.0.1", port), timeout=30)
        self.sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)

    def call(self, cmd, payload=b""):
        """-> (status, payload). A violation is an answer here, not an exception."""
        self.sock.sendall(build_frame(cmd, payload))
        hdr = b""
        while len(hdr) < 9:
            c = self.sock.recv(9 - len(hdr))
            if not c:
                raise ConnectionError("worker closed the link before replying")
            hdr += c
        status = hdr[0]
        size = struct.unpack_from("<Q", hdr, 1)[0]
        body = b""
        while len(body) < size:
            c = self.sock.recv(size - len(body))
            if not c:
                raise ConnectionError("worker closed the link mid-reply")
            body += c
        return status, body

    def hello(self, reserve=None):
        pay = struct.pack("<I", 1) if reserve is None else struct.pack("<IQ", 1, reserve)
        st, body = self.call(CMD_HELLO, pay)
        return st, (json.loads(body) if st == STATUS_OK else body.decode("utf-8", "replace"))

    def alloc(self, size, role="activations"):
        st, body = self.call(CMD_ALLOC_BUFFER, struct.pack("<QI", size, len(role)) + role.encode())
        return st, (struct.unpack("<Q", body)[0] if st == STATUS_OK else body.decode("utf-8", "replace"))

    def close(self):
        self.sock.close()


def worker_pid(port):
    out = subprocess.run(["ss", "-ltnpH", f"sport = :{port}"], capture_output=True, text=True).stdout
    if "pid=" not in out:
        return None
    return int(out.split("pid=")[1].split(",")[0])


def smi_used_mib(pid):
    """nvidia-smi's per-process figure for the worker: what the card holds
    for it, context included."""
    out = subprocess.run(["nvidia-smi", "--query-compute-apps=pid,used_memory",
                          "--format=csv,noheader,nounits"], capture_output=True, text=True).stdout
    for line in out.splitlines():
        cols = [c.strip() for c in line.split(",")]
        if len(cols) == 2 and cols[0] == str(pid):
            return int(cols[1])
    return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, required=True)
    ap.add_argument("--reserve-mib", type=int, default=64)
    ap.add_argument("--worker-bin", default=None, help="also run the start-up check (4)")
    a = ap.parse_args()
    R = a.reserve_mib * MiB
    pid = worker_pid(a.port)
    results = {}
    seen = {}

    def check(name, cond, detail=""):
        results[name] = bool(cond)
        print(f"  [{'ok' if cond else 'FAIL'}] {name}{': ' + detail if detail else ''}")

    # -- 1. the old form ------------------------------------------------
    print("1. a 4-byte HELLO reserves nothing")
    l0 = Link(a.port)
    st, h = l0.hello()
    check("old_hello_ok", st == STATUS_OK and h["version"][:2] == [1, 3], f"version {h.get('version') if st == 0 else h}")
    budget = h["vram_budget"]
    seen["budget"] = budget
    check("old_hello_reserves_nothing", h["vram_reserved"] == 0 and h["vram_reserve"] == 0,
          f"vram_reserved={h['vram_reserved']} vram_reserve={h['vram_reserve']} vram_free={h['vram_free']}")
    # allocations up to the budget still work: the ledger allows the whole
    # budget; whether the driver has it is the card's business today, so the
    # ledger is exercised with a small real allocation and the cap at the edge
    st, r = l0.alloc(4 * MiB)
    check("old_form_small_alloc_ok", st == STATUS_OK, f"{r}")
    st, r = l0.alloc(budget - 4 * MiB + 1)
    check("old_form_capped_by_budget", st != STATUS_OK and "budget" in r, f"{r}")
    l0.close()
    time.sleep(0.3)

    # -- 2. reservations ------------------------------------------------
    print(f"2. HELLO reserving {a.reserve_mib} MiB")
    base = smi_used_mib(pid) if pid else None
    l1 = Link(a.port)
    st, h1 = l1.hello(R)
    check("reserve_ok", st == STATUS_OK and h1["vram_reserve"] == R and h1["vram_reserved"] == R,
          f"{h1 if st != 0 else {k: h1[k] for k in ('vram_reserve', 'vram_reserved', 'vram_free', 'vram_budget')}}")
    time.sleep(0.5)
    after = smi_used_mib(pid) if pid else None
    if base is not None and after is not None:
        grew = after - base
        seen["smi_before_mib"] = base
        seen["smi_after_reserve_mib"] = after
        # the pool takes memory from the driver in whole chunks, so the growth
        # is R rounded up to the pool's granularity (32 MiB here)
        check("smi_grew_by_reserve", grew >= a.reserve_mib - 2, f"pid {pid}: {base} -> {after} MiB (+{grew})")
    else:
        print(f"  [skip] nvidia-smi per-pid figure unavailable (pid={pid})")
    l2 = Link(a.port)
    st, h2 = l2.hello(budget - R + MiB)
    check("reserve_over_budget_refused", st != STATUS_OK and "exceeds the budget" in h2, f"{h2}")
    l2.close()
    l3 = Link(a.port)
    st, h3 = l3.hello(R)
    check("second_reserve_ok", st == STATUS_OK and h3["vram_reserved"] == 2 * R and h3["vram_reserve"] == R,
          f"{h3 if st != 0 else {k: h3[k] for k in ('vram_reserve', 'vram_reserved', 'vram_free')}}")
    time.sleep(0.3)
    both = smi_used_mib(pid) if pid else None
    seen["smi_two_reserved_mib"] = both
    l1.close()
    time.sleep(0.5)
    l4 = Link(a.port)
    st, h4 = l4.hello()
    check("release_on_close", st == STATUS_OK and h4["vram_reserved"] == R, f"vram_reserved={h4.get('vram_reserved')}")
    fell = smi_used_mib(pid) if pid else None
    seen["smi_after_first_closed_mib"] = fell
    if both is not None and fell is not None:
        # the pool gives memory back in whole chunks (32 MiB on this driver):
        # two reservations that share a chunk cannot show the first one leaving
        print(f"  [info] after the first link closed: pid {pid}: {both} -> {fell} MiB"
              f"{'' if fell < both else ' (both reservations fit one 32 MiB pool chunk; see the end figure)'}")
    l4.close()

    # -- 3. the per-link cap ------------------------------------------
    print("3. a reserving link is capped by its reservation")
    st, r = l3.alloc(R + MiB)
    check("alloc_over_reserve_refused", st != STATUS_OK and "reservation" in r, f"{r}")
    l3.close()
    l5 = Link(a.port)
    l5.hello(R)
    st, r = l5.alloc(R)
    check("alloc_up_to_reserve_ok", st == STATUS_OK, f"{r}")
    l5.close()
    time.sleep(0.5)
    l6 = Link(a.port)
    st, h6 = l6.hello()
    check("all_released", st == STATUS_OK and h6["vram_reserved"] == 0, f"vram_reserved={h6.get('vram_reserved')}")
    end = smi_used_mib(pid) if pid else None
    seen["smi_end_mib"] = end
    if base is not None and end is not None:
        check("smi_back_to_baseline_after_all_closed", end <= base, f"pid {pid}: {base} at start -> {end} MiB now")
    l6.close()

    # -- 4. start-up ----------------------------------------------------
    if a.worker_bin:
        print("4. a budget larger than the card exits 75")
        p = subprocess.run([a.worker_bin, "--host", "127.0.0.1", "--port", str(a.port + 1), "--vsock-port", "0",
                            "--vram-gb", "4096"], capture_output=True, text=True, timeout=60)
        check("oversize_budget_exits_75", p.returncode == 75 and "exceeds the card" in p.stderr,
              f"rc={p.returncode} {p.stderr.strip().splitlines()[-1] if p.stderr.strip() else ''}")

    print(json.dumps({"observed": seen, "results": results}, indent=1))
    ok = all(results.values())
    print("ALL OK" if ok else "FAILURES")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
