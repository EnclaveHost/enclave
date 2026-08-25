#!/usr/bin/env python3
"""
worker.py -- the shielded GPU worker. Runs on the UNTRUSTED host, holds the card.

This is the component docs/shielded-inference.md calls "the worker", and it is
deliberately the least trusted thing in the system. It sees:

  * public weights, in their native GGUF quantisation, and
  * masked activations: x + r over Z_M for a one-time pad r it never receives.

It does not see, and cannot be asked to compute, anything else. No softmax, no
norms, no rope, no sampling, no attention. Those are refused by name in
protocol.py's denylist and the refusal is diagnostic, not a generic error.

TRUST POSTURE -- read this before "improving" anything here
-----------------------------------------------------------
The operator of this process is assumed hostile and assumed to have replaced it
entirely. Nothing in this file is a security control for the TENANT: confidentiality
comes from the mask, and honesty comes from Freivalds verification in the TEE. What
the admission rules buy is that a worker following them cannot be turned into a
general-purpose execution and exfiltration primitive on the GPU host -- which
protects the HOST OPERATOR and every other tenant of that box, not the tenant whose
tokens are passing through.

So: a bug here cannot leak plaintext (there is none to leak), but a bug here CAN
turn a GPU box into an attacker's shell. That is why it fails closed on every path.

WHAT IT ACTUALLY COMPUTES
-------------------------
FIELD_GEMM: y = (x+r) . W over Z_M, with W dequantised from q8_0 and re-encoded to
RNS residues in registers, and the CRT recombination fused into the epilogue. The
kernel is kernels/fused_field_gemm.py; this file is its server. The TEE subtracts
u = r.W to recover x.W exactly.

CONCURRENCY
-----------
One thread per connection, one ShieldedWorkerState per connection, and a single
global lock around kernel launches. Per-connection state means a hostile or broken
peer cannot reach another peer's buffers even by index confusion: bids are scoped
to the connection and freed with it. VRAM, however, is shared, so the lock also
serialises allocation accounting.
"""

import argparse
import json
import os
import socket
import struct
import sys
import threading
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "kernels"))

import numpy as np
import torch

from protocol import (CMD_ALLOC_BUFFER, CMD_FREE_BUFFER, CMD_GET_TENSOR,
                      CMD_GRAPH_INSTALL, CMD_GRAPH_RECOMPUTE, CMD_HELLO,
                      CMD_SET_TENSOR, PROTO_VERSION, ProtocolViolation,
                      ShieldedWorkerState)
import wire
from fused_field_gemm import QK, field_gemm

GPU_LOCK = threading.Lock()


class Node:
    """A resolved, validated FIELD_GEMM. Resolution happens once at install; the
    per-token doorbell then does no parsing at all, which is both the fast path
    and the safe one -- there is no attacker-supplied structure left to
    misinterpret at compute time."""

    __slots__ = ("nid", "wq", "wd", "xs", "y", "K", "N", "max_m")

    def __init__(self, nid, wq, wd, xs, y, K, N, max_m):
        self.nid, self.wq, self.wd, self.xs, self.y = nid, wq, wd, xs, y
        self.K, self.N, self.max_m = K, N, max_m


class Connection:
    def __init__(self, sock, addr, vram_bytes, log):
        self.sock = sock
        self.addr = addr
        self.log = log
        self.state = ShieldedWorkerState(vram_bytes=vram_bytes)
        self.storage = {}      # bid -> uint8 cuda tensor
        self.nodes = []
        self.recomputes = 0
        self.gemm_ms = 0.0

    # -- buffer helpers ----------------------------------------------------
    def _bytes_view(self, bid, offset, nbytes):
        """A uint8 view of a region. protocol.py has already bounds-checked it;
        this re-derives the same bound from the real allocation rather than
        trusting that, because the two must never be able to disagree."""
        buf = self.storage.get(bid)
        if buf is None:
            raise ProtocolViolation(f"no storage for buffer {bid}")
        if offset < 0 or nbytes < 0 or offset + nbytes > buf.numel():
            raise ProtocolViolation(f"region outside storage for buffer {bid}")
        return buf[offset:offset + nbytes]

    def _typed(self, bid, offset, shape, dtype, role=None):
        """A typed view of a region, with the element count checked against the
        shape. Alignment is enforced: a misaligned view() would either throw deep
        inside torch or, worse, silently reinterpret."""
        itemsize = torch.empty(0, dtype=dtype).element_size()
        n = 1
        for s in shape:
            n *= s
        nbytes = n * itemsize
        if role is not None:
            declared = self.state.buffers.get(bid)
            if declared is None or declared.role != role:
                raise ProtocolViolation(
                    f"buffer {bid} has role {declared.role if declared else None!r}, want {role!r}")
        if offset % itemsize:
            raise ProtocolViolation(f"offset {offset} misaligned for {dtype}")
        return self._bytes_view(bid, offset, nbytes).view(dtype).view(*shape)

    # -- command handlers --------------------------------------------------
    def handle(self, cmd, payload):
        # Admission FIRST, always. Everything below may assume the frame is
        # structurally legal and in-bounds; nothing below may assume it is
        # semantically sane.
        res = self.state.handle(cmd, payload)

        if cmd == CMD_HELLO:
            info = {
                "version": list(PROTO_VERSION),
                "device": torch.cuda.get_device_name(0),
                "vram_total": torch.cuda.get_device_properties(0).total_memory,
                "vram_budget": self.state.vram_bytes,
                "worker": "shielded/worker.py",
            }
            return json.dumps(info).encode()

        if cmd == CMD_ALLOC_BUFFER:
            bid = res["bid"]
            size = struct.unpack_from("<Q", payload, 0)[0]
            try:
                self.storage[bid] = torch.empty(size, dtype=torch.uint8, device="cuda")
            except torch.cuda.OutOfMemoryError as e:
                # The accounting said it fits and the driver disagreed. Fail the
                # connection rather than leaving the state machine's view of VRAM
                # diverged from the card's.
                raise ProtocolViolation(f"device allocation of {size} failed: {e}")
            return struct.pack("<Q", bid)

        if cmd == CMD_FREE_BUFFER:
            bid = struct.unpack_from("<Q", payload, 0)[0]
            self.storage.pop(bid, None)
            return b""

        if cmd == CMD_SET_TENSOR:
            bid, offset, nbytes = struct.unpack_from("<QQQ", payload, 0)
            data = payload[24:]
            if len(data) != nbytes:
                raise ProtocolViolation(
                    f"SET_TENSOR declared {nbytes} bytes, frame carries {len(data)}")
            view = self._bytes_view(bid, offset, nbytes)
            src = torch.frombuffer(bytearray(data), dtype=torch.uint8)
            view.copy_(src, non_blocking=False)
            return b""

        if cmd == CMD_GET_TENSOR:
            bid, offset, nbytes = struct.unpack_from("<QQQ", payload, 0)
            view = self._bytes_view(bid, offset, nbytes)
            return view.cpu().numpy().tobytes()

        if cmd == CMD_GRAPH_INSTALL:
            spec = json.loads(payload.decode("utf-8"))
            self._resolve(spec)
            return json.dumps({"nodes": len(self.nodes)}).encode()

        if cmd == CMD_GRAPH_RECOMPUTE:
            node_idx, m = wire.unpack_recompute(payload)
            return self._recompute(node_idx, m)

        return b""

    # -- graph resolution --------------------------------------------------
    def _resolve(self, spec):
        """Bind every allowlisted node to real storage, or refuse the graph.

        protocol.py validated the OP of each node. This validates the BINDINGS:
        shapes, sizes, alignment, and -- the invariant that matters -- that
        weights come from a 'weights' buffer and activations from an
        'activations' buffer. Without that last check a graph could declare an
        activation region as its weight operand, and the worker would happily
        treat a masked activation as public data.
        """
        for i, n in enumerate(spec["nodes"]):
            if n.get("op") != "FIELD_GEMM":
                # VIEW/RESHAPE/PERMUTE/TRANSPOSE/CONT/CPY are metadata-only and
                # carry no compute; they are allowed through admission but this
                # worker resolves them to nothing. Keeping them in the allowlist
                # matters for the C++ port, where sched does emit them.
                self.nodes.append(None)
                continue
            K, N, max_m = int(n["K"]), int(n["N"]), int(n["max_m"])
            if K <= 0 or N <= 0 or max_m <= 0:
                raise ProtocolViolation(f"node {i}: non-positive shape")
            if K % QK:
                raise ProtocolViolation(f"node {i}: K={K} is not a multiple of {QK}")
            if max_m > 4096:
                raise ProtocolViolation(f"node {i}: max_m={max_m} exceeds 4096")
            wq = self._typed(n["wq"]["bid"], n["wq"]["offset"], (K, N), torch.int8, "weights")
            wd = self._typed(n["wd"]["bid"], n["wd"]["offset"], (K // QK, N), torch.float16, "weights")
            xs = []
            xoff = n["x"]["offset"]
            plane = max_m * K
            for p in range(3):
                xs.append(self._typed(n["x"]["bid"], xoff + p * plane, (max_m, K),
                                      torch.int8, "activations"))
            y = self._typed(n["y"]["bid"], n["y"]["offset"], (max_m, N), torch.int32, "activations")
            self.nodes.append(Node(n.get("id", f"node{i}"), wq, wd, xs, y, K, N, max_m))
        if not any(nd is not None for nd in self.nodes):
            raise ProtocolViolation("graph contains no computable node")

    def _recompute(self, node_idx, m):
        if node_idx >= len(self.nodes):
            raise ProtocolViolation(f"recompute of node {node_idx}, graph has {len(self.nodes)}")
        node = self.nodes[node_idx]
        if node is None:
            raise ProtocolViolation(f"node {node_idx} is metadata-only; nothing to compute")
        if m < 1 or m > node.max_m:
            raise ProtocolViolation(f"m={m} outside [1,{node.max_m}] for node {node_idx}")
        t0 = time.perf_counter()
        with GPU_LOCK:
            xr = [p[:m] for p in node.xs]
            out = field_gemm(xr, node.wq, node.wd, m, node.N)
            node.y[:m].copy_(out)
            torch.cuda.synchronize()
        self.gemm_ms += (time.perf_counter() - t0) * 1e3
        self.recomputes += 1
        return struct.pack("<I", m)

    # -- loop --------------------------------------------------------------
    def serve(self):
        try:
            while True:
                try:
                    cmd, payload = wire.recv_request(self.sock)
                except ConnectionError:
                    break
                try:
                    resp = self.handle(cmd, payload)
                except ProtocolViolation as e:
                    self.log(f"VIOLATION from {self.addr}: {e}")
                    self.sock.sendall(wire.build_response(wire.STATUS_VIOLATION, str(e).encode()))
                    break
                except Exception as e:  # noqa: BLE001
                    # Any unexpected exception is treated as a violation too: an
                    # unhandled error means we no longer know what state we are
                    # in, and guessing is exactly what fails-closed forbids.
                    self.log(f"INTERNAL from {self.addr}: {type(e).__name__}: {e}")
                    self.sock.sendall(wire.build_response(
                        wire.STATUS_VIOLATION, f"internal: {type(e).__name__}: {e}".encode()))
                    break
                self.sock.sendall(wire.build_response(wire.STATUS_OK, resp))
        finally:
            # Per-connection VRAM dies with the connection. Nothing secret was
            # ever in it, but a leaked buffer is a denial-of-service on the card.
            self.storage.clear()
            torch.cuda.empty_cache()
            try:
                self.sock.close()
            except OSError:
                pass


def serve(host, port, vram_gb, quiet=False):
    def log(msg):
        if not quiet:
            print(f"[shielded-worker] {msg}", flush=True)

    if not torch.cuda.is_available():
        raise SystemExit("no CUDA device; the shielded worker is the GPU half by definition")

    props = torch.cuda.get_device_properties(0)
    budget = int(vram_gb * (1 << 30)) if vram_gb else int(props.total_memory * 0.85)
    log(f"{props.name}, sm_{props.major}{props.minor}, "
        f"{props.total_memory / 2**30:.1f} GiB total, budget {budget / 2**30:.1f} GiB")

    srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    srv.bind((host, port))
    srv.listen(8)
    log(f"listening on {host}:{port}"
        + (f" (guest reaches it at 10.0.2.2:{port})" if host in ("127.0.0.1", "0.0.0.0") else ""))

    while True:
        sock, addr = srv.accept()
        sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        conn = Connection(sock, addr, budget, log)
        t = threading.Thread(target=conn.serve, daemon=True, name=f"conn-{addr[1]}")
        t.start()


def main():
    ap = argparse.ArgumentParser(description="shielded GPU worker (untrusted host side)")
    ap.add_argument("--host", default="127.0.0.1",
                    help="bind address; 127.0.0.1 is reachable from a slirp guest at 10.0.2.2")
    ap.add_argument("--port", type=int, default=int(os.environ.get("SHIELDED_PORT", "9500")))
    ap.add_argument("--vram-gb", type=float, default=0.0, help="0 = 85%% of the card")
    ap.add_argument("--quiet", action="store_true")
    a = ap.parse_args()
    serve(a.host, a.port, a.vram_gb, a.quiet)


if __name__ == "__main__":
    main()
