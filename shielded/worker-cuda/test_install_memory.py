#!/usr/bin/env python3
"""Exercise a NEW scratch worker's weight installation and report Linux RSS.

CUDA_VISIBLE_DEVICES=<idle card> python3 test_install_memory.py --worker-bin ./shielded-worker
Add --benchmark for a 64 MiB encoded matrix uploaded in production-size 32 MiB
chunks. Run old/new binaries in fresh processes; compare the JSON, not CI timing
thresholds. No model, secrets, production port, or external service is used.
"""
import argparse
import json
import os
from pathlib import Path
import socket
import struct
import subprocess
import sys
import tempfile
import time

from test_reservation import Link


def ok(link, command, payload=b""):
    status, body = link.call(command, payload)
    assert status == 0, body
    return body


def allocate(link, size, role):
    status, bid = link.alloc(size, role)
    assert status == 0, bid
    return bid


def upload(link, bid, data):
    chunk = 32 << 20  # the TEE's in-memory public-weight upload chunk
    for offset in range(0, len(data), chunk):
        part = data[offset:offset + chunk]
        ok(link, 8, struct.pack("<QQQ", bid, offset, len(part)) + part)


def memory(pid):
    fields = {}
    for line in Path(f"/proc/{pid}/status").read_text().splitlines():
        key, _, value = line.partition(":")
        if key in ("VmRSS", "VmHWM"):
            fields[key + "_kib"] = int(value.split()[0])
    return fields


def setup(port, k, n, data):
    link = Link(port)
    status, hello = link.hello()
    assert status == 0, hello
    wb = allocate(link, len(data), "weights")
    ab = allocate(link, 3 * k + 4 * n, "activations")
    upload(link, wb, data)
    node = {"op": "FIELD_GEMM", "K": k, "N": n, "max_m": 1,
            "w": {"bid": wb, "offset": 0},
            "x": {"bid": ab, "offset": 0}, "y": {"bid": ab, "offset": 3 * k}}
    graph = {"nodes": [node], "outputs": [{"bid": ab, "offset": 3 * k, "nbytes": 4 * n}]}
    return link, wb, ab, graph


def product(link, k, expected, count=1):
    # Synthetic residue planes encode x=1 in each lane. Products must be exact.
    payload = struct.pack("<II", count, 1) + struct.pack("<" + "I" * count, *range(count)) + bytes([1]) * (3 * k)
    for command, width in ((12, 4), (13, 3), (12, 4)):
        raw = ok(link, command, payload)
        got = [int.from_bytes(raw[i:i + width], "little", signed=True) for i in range(0, len(raw), width)]
        assert got == expected, (got[:8], expected[:8])


def regression(port):
    k, n = 32, 4
    values = [-119, -1, 1, 119]
    encoded = b"".join(bytes([v & 255]) * k for v in values)
    prefix = b"offset!"
    link, wb, ab, graph = setup(port, k, n, prefix + encoded)
    try:
        graph["nodes"][0]["w"]["offset"] = len(prefix)
        # Two graph nodes may reference the same owned weight bytes.
        graph["nodes"] *= 2
        ok(link, 10, json.dumps(graph).encode())
        # Dropping the consumed host buffer cannot invalidate installed weights.
        ok(link, 2, struct.pack("<Q", wb))
        product(link, k, [v * k for v in values] * 2, 2)
        # The ordinary control receive buffer remains usable after installation.
        ok(link, 8, struct.pack("<QQQ", ab, 0, 3 * k) + bytes([1]) * (3 * k))
        ok(link, 11, struct.pack("<II", 0, 1))
        raw = ok(link, 9, struct.pack("<QQQ", ab, 3 * k, 4 * n))
        assert list(struct.unpack("<4i", raw)) == [v * k for v in values]
        status, body = link.call(10, json.dumps(graph).encode())
        assert status != 0 and b"already installed" in body
    finally:
        link.close()

    # The legacy q8/half-scale conversion still owns its temporary encoding.
    legacy = bytes([v & 255 for v in values]) * k
    link, wb, _, graph = setup(port, k, n, legacy)
    try:
        db = allocate(link, 2 * n, "weights")
        upload(link, db, struct.pack("<e", 1 / 256) * n)
        node = graph["nodes"][0]
        del node["w"]
        node.update(wq={"bid": wb, "offset": 0}, wd={"bid": db, "offset": 0})
        ok(link, 10, json.dumps(graph).encode())
        product(link, k, [v * k for v in values])
    finally:
        link.close()

    for invalid in (120, -120):
        # Refuse the LAST weight of a second node after uploading the first.
        link, _, _, graph = setup(port, k, 1, bytes([1]) * (2 * k - 1) + bytes([invalid & 255]))
        try:
            second = json.loads(json.dumps(graph["nodes"][0]))
            second["w"]["offset"] = k
            graph["nodes"].append(second)
            status, body = link.call(10, json.dumps(graph).encode())
            assert status != 0 and b"int8 lane" in body
        finally:
            link.close()
    # Fresh connection after refusals proves the worker remains available.
    link, _, _, graph = setup(port, k, 1, bytes([1]) * k)
    try:
        ok(link, 10, json.dumps(graph).encode())
        product(link, k, [k])
    finally:
        link.close()
    return {"regression": "passed", "checks": ["shared nonzero-offset encoded weights",
            "both reply widths and graph replay", "control calls after install", "legacy conversion",
            "positive and negative lane bounds after partial install", "reinstall refusal", "reconnect after refusal"]}


def benchmark(port, pid):
    k = n = 8192
    baseline = memory(pid)
    link, _, _, graph = setup(port, k, n, bytes([1]) * (k * n))
    try:
        uploaded = memory(pid)
        start = time.perf_counter()
        ok(link, 10, json.dumps(graph).encode())
        install_ms = (time.perf_counter() - start) * 1000
        installed = memory(pid)
        product(link, k, [k] * n)
        return {"matrix_bytes": k * n, "upload_chunk_bytes": 32 << 20,
                "install_ms": install_ms, "baseline": baseline, "uploaded": uploaded,
                "installed": installed, "products": "exact"}
    finally:
        link.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--worker-bin", type=Path, required=True)
    parser.add_argument("--benchmark", action="store_true")
    args = parser.parse_args()
    with socket.socket() as slot:
        slot.bind(("127.0.0.1", 0))
        port = slot.getsockname()[1]
    env = {k: v for k, v in os.environ.items() if not k.startswith("SHIELDED_")}
    with tempfile.TemporaryFile(mode="w+") as log:
        proc = subprocess.Popen([str(args.worker_bin.resolve()), "--host", "127.0.0.1",
                                 "--port", str(port), "--vsock-port", "0", "--vram-gb", "0.5"],
                                stdout=log, stderr=log, env=env)
        try:
            deadline = time.monotonic() + 30
            while True:
                assert proc.poll() is None, "scratch worker exited before listening"
                log.seek(0)
                # Wait on THIS process's startup, never connect to an unrelated listener.
                if f"listening on 127.0.0.1:{port}" in log.read():
                    break
                if time.monotonic() > deadline:
                    raise TimeoutError("scratch worker startup")
                time.sleep(0.05)
            print(json.dumps(benchmark(port, proc.pid) if args.benchmark else regression(port)))
        except BaseException:
            log.seek(0)
            print(log.read(), file=sys.stderr)
            raise
        finally:
            if proc.poll() is None:
                proc.terminate()
            try:
                proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait()


if __name__ == "__main__":
    main()
