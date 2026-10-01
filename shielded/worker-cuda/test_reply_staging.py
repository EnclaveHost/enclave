#!/usr/bin/env python3
"""Check packed reply bounds/results in NEW scratch CUDA workers on an idle GPU.

Builds a test-only LD_PRELOAD guard with c++; requires Linux and CUDA. Every
pinned host allocation has a checked 64-byte tail, including allocations much
smaller than a page. Never connects to a production worker. --benchmark reports
requested mapped-host allocation bytes and RSS for one large packed reply in a
fresh connection. The instrumentation is for memory/correctness, not timing.
"""
import argparse
import json
import os
from pathlib import Path
import socket
import struct
import subprocess
import tempfile
import time

from test_install_memory import allocate, memory, ok, upload
from test_reservation import Link

K = 32
VALUES = (-119, -1, 1, 119)


def setup(port, ns, max_m):
    link = Link(port)
    assert link.hello()[0] == 0
    weights = b"".join(bytes([VALUES[(j + i) % 4] & 255]) * K
                       for i, n in enumerate(ns) for j in range(n))
    wb = allocate(link, len(weights), "weights")
    ab = allocate(link, max_m * (3 * K + 4 * sum(ns)), "activations")
    upload(link, wb, weights)
    nodes, woff, yoff = [], 0, 3 * K * max_m
    for n in ns:
        nodes.append({"op": "FIELD_GEMM", "K": K, "N": n, "max_m": max_m,
                      "w": {"bid": wb, "offset": woff},
                      "x": {"bid": ab, "offset": 0}, "y": {"bid": ab, "offset": yoff}})
        woff += K * n
        yoff += 4 * n * max_m
    graph = {"nodes": nodes, "outputs": [{"bid": ab, "offset": 3 * K * max_m,
                                          "nbytes": 4 * sum(ns) * max_m}]}
    ok(link, 10, json.dumps(graph).encode())
    return link


def product(link, ns, indices, m, width):
    planes = b"".join(bytes([r + 1]) * K for r in range(m)) * 3
    payload = struct.pack("<II", len(indices), m) + struct.pack("<" + "I" * len(indices), *indices) + planes
    raw = ok(link, 13 if width == 3 else 12, payload)
    expected = b"".join((K * (r + 1) * VALUES[(j + i) % 4]).to_bytes(width, "little", signed=True)
                        for i in indices for r in range(m) for j in range(ns[i]))
    assert raw == expected, (indices, m, width, len(raw), len(expected))


def regression(port):
    # Fresh connections give tiny packed outputs a genuinely small allocation.
    cases = [[1], [2], [3], [5], [31], [32], [33], [129], [256],
             [1, 2, 3, 5, 31, 32, 33, 129, 256], [1] * 64]
    exchanges = 0
    for ns in cases:
        link = setup(port, ns, 17)
        try:
            indices = list(range(len(ns)))
            # Grow input and output, replay, switch widths, and replay the old
            # shape after growth. More than eight rows/nodes span kernel passes.
            for m in (1, 2, 7, 8, 9, 17, 1):
                for width in (3, 3, 4, 3):
                    product(link, ns, indices, m, width)
                    exchanges += 1
            if len(ns) > 1:
                product(link, ns, indices[::-1], 3, 3)
                product(link, ns, [len(ns) - 1, 0, len(ns) - 1], 9, 3)
                exchanges += 2
        finally:
            link.close()
    return {"regression": "passed", "exchanges": exchanges, "bounds": "64-byte canaries intact"}


def benchmark(port, pid, trace):
    ns, m = [65536], 32
    link = setup(port, ns, m)
    try:
        start = len(trace.read_text().splitlines())
        before = memory(pid)
        product(link, ns, [0], m, 3)
        after = memory(pid)
        allocations = [tuple(map(int, row.split())) for row in trace.read_text().splitlines()[start:]]
        return {"elements": m * ns[0], "reply_bytes": 3 * m * ns[0], "before": before, "after": after,
                "mapped_host_allocation_bytes": [n for n, flags in allocations if flags & 2],
                "products": "exact", "bounds": "64-byte canaries intact"}
    finally:
        link.close()


def run(worker, guard, directory, mode, bench):
    trace = directory / (mode + ".allocations")
    trace.touch()
    logpath = directory / (mode + ".log")
    with socket.socket() as slot:
        slot.bind(("127.0.0.1", 0))
        port = slot.getsockname()[1]
    env = {k: v for k, v in os.environ.items() if not k.startswith("SHIELDED_")}
    env.update(SHIELDED_WORKER_PACK=mode, LD_PRELOAD=str(guard), SH_HOST_ALLOC_TRACE=str(trace))
    with logpath.open("w+") as log:
        proc = subprocess.Popen([str(worker), "--host", "127.0.0.1", "--port", str(port),
                                 "--vsock-port", "0", "--vram-gb", "0.5"], stdout=log, stderr=log, env=env)
        try:
            deadline = time.monotonic() + 30
            while f"listening on 127.0.0.1:{port}" not in logpath.read_text():
                assert proc.poll() is None, "scratch worker exited before listening"
                if time.monotonic() > deadline:
                    raise TimeoutError("scratch worker startup")
                time.sleep(0.05)
            result = benchmark(port, proc.pid, trace) if bench else regression(port)
            assert trace.stat().st_size > 0, "host allocation guard was not loaded"
            assert proc.poll() is None, "scratch worker exited"
            return {"pack": mode, **result}
        except BaseException:
            print(logpath.read_text())
            raise
        finally:
            if proc.poll() is None:
                proc.terminate()
            try:
                proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--worker-bin", type=Path, required=True)
    parser.add_argument("--pack", choices=("epilogue", "kernel", "cpu", "all"), default="all")
    parser.add_argument("--benchmark", action="store_true")
    args = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix="shield-reply-") as temp:
        directory = Path(temp)
        guard = directory / "host-guard.so"
        subprocess.run(["c++", "-std=c++17", "-shared", "-fPIC", "-O2",
                        str(Path(__file__).with_name("test_host_alloc_guard.cpp")), "-ldl", "-pthread",
                        "-o", str(guard)], check=True)
        modes = ("epilogue", "kernel", "cpu") if args.pack == "all" else (args.pack,)
        print(json.dumps([run(args.worker_bin.resolve(), guard, directory, mode, args.benchmark) for mode in modes]))


if __name__ == "__main__":
    main()
