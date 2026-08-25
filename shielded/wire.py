#!/usr/bin/env python3
"""
wire.py -- the socket layer for the shielded worker, and nothing else.

protocol.py is deliberately transport-free: it decides admission from bytes and
holds no sockets, so the same logic can be lifted into the C++/CUDA worker and
still be tested here. This module is the other half -- it moves those frames over
TCP and defines the response framing protocol.py has no opinion about.

FRAMING
-------
Request  (protocol.build_frame):  | cmd u8    | size u64 LE | payload |
Response (this module):           | status u8 | size u64 LE | payload |

status 0 = OK, 1 = VIOLATION (payload is a UTF-8 reason). A violation is always
the last frame on the connection: the worker closes immediately after sending it,
because protocol.py's contract is that a violation terminates rather than warns.

WHY A SEPARATE RESPONSE STATUS BYTE
-----------------------------------
The TEE has to distinguish "the worker refused" from "the worker lied" from "the
socket died". The first is a protocol bug on our side and should be loud in tests;
the second is caught by Freivalds and must abort the request; the third is a
liveness event and may be retried. Collapsing them into a closed socket -- which
is what stock ggml-rpc does -- makes the first two indistinguishable in
production, and the whole tier rests on being able to tell them apart.

PIPELINING
----------
A masked exchange is three frames (SET_TENSOR, RECOMPUTE, GET_TENSOR) and would
cost three round trips if each waited for its response. `Pipe.exchange` writes all
three in ONE write() and then reads the three responses, so an exchange costs one
RTT plus the worker's compute. On the metal0 host<->guest link (slirp loopback,
7.2 us ping) the difference is 4.6 ms/token at 32 layers, which is the difference
between transport being a rounding error and transport being the second-largest
term in the budget.

TCP_NODELAY is mandatory, not an optimisation: without it Nagle holds the small
SET_TENSOR frame waiting for an ACK that the pipelined GET_TENSOR is itself
waiting on, and the exchange stalls for a full delayed-ACK timer (40 ms here).
"""

import socket
import struct

from protocol import ProtocolViolation, build_frame

STATUS_OK = 0
STATUS_VIOLATION = 1

# A single frame is capped well below the point where a bad length header could
# make the peer allocate the machine. The largest legitimate payload is a weight
# upload chunk; everything else is kilobytes.
MAX_FRAME = 256 << 20


def build_response(status, payload=b""):
    return bytes([status]) + struct.pack("<Q", len(payload)) + payload


def recv_exact(sock, n):
    """Read exactly n bytes or raise. Short reads are the norm on a real socket
    and the single most common source of 'works on loopback' bugs."""
    parts = []
    got = 0
    while got < n:
        chunk = sock.recv(min(n - got, 1 << 20))
        if not chunk:
            raise ConnectionError(f"peer closed after {got} of {n} bytes")
        parts.append(chunk)
        got += len(chunk)
    return b"".join(parts) if len(parts) > 1 else parts[0]


def recv_request(sock):
    """Read one request frame. Returns (cmd, payload).

    The length is validated BEFORE allocating for the payload -- protocol.py
    checks a declared size against a buffer it already holds, which cannot help
    a reader that has to decide how much to read in the first place.
    """
    head = recv_exact(sock, 9)
    cmd = head[0]
    size = struct.unpack_from("<Q", head, 1)[0]
    if size > MAX_FRAME:
        raise ProtocolViolation(f"frame size {size} exceeds {MAX_FRAME}")
    payload = recv_exact(sock, size) if size else b""
    return cmd, payload


def recv_response(sock):
    head = recv_exact(sock, 9)
    status = head[0]
    size = struct.unpack_from("<Q", head, 1)[0]
    if size > MAX_FRAME:
        raise ProtocolViolation(f"response size {size} exceeds {MAX_FRAME}")
    payload = recv_exact(sock, size) if size else b""
    return status, payload


class WorkerRefused(Exception):
    """The worker rejected a frame. Our bug, or an attacker mid-path; either way
    the request is over. Distinct from an integrity failure, which means the
    worker answered but lied."""


class Pipe:
    """Client-side connection to a shielded worker."""

    def __init__(self, host, port, timeout=120.0):
        self.sock = socket.create_connection((host, port), timeout=timeout)
        self.sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        self.bytes_out = 0
        self.bytes_in = 0

    def call(self, cmd, payload=b""):
        """One request, one response. Raises WorkerRefused on a violation."""
        frame = build_frame(cmd, payload)
        self.sock.sendall(frame)
        self.bytes_out += len(frame)
        status, resp = recv_response(self.sock)
        self.bytes_in += len(resp) + 9
        if status != STATUS_OK:
            raise WorkerRefused(resp.decode("utf-8", "replace"))
        return resp

    def exchange(self, frames):
        """Write several request frames in one syscall, then collect all their
        responses. The ordering guarantee is TCP's; the worker answers in
        request order and never reorders."""
        blob = b"".join(build_frame(c, p) for c, p in frames)
        self.sock.sendall(blob)
        self.bytes_out += len(blob)
        out = []
        for _ in frames:
            status, resp = recv_response(self.sock)
            self.bytes_in += len(resp) + 9
            if status != STATUS_OK:
                raise WorkerRefused(resp.decode("utf-8", "replace"))
            out.append(resp)
        return out

    def close(self):
        try:
            self.sock.close()
        except OSError:
            pass


# -- payload codecs, shared by both sides ------------------------------------
def pack_hello(major):
    return struct.pack("<I", major)


def pack_alloc(size, role):
    return struct.pack("<Q", size) + struct.pack("<I", len(role)) + role.encode()


def pack_free(bid):
    return struct.pack("<Q", bid)


def pack_region(bid, offset, nbytes):
    return struct.pack("<QQQ", bid, offset, nbytes)


def pack_set_tensor(bid, offset, data):
    return struct.pack("<QQQ", bid, offset, len(data)) + data


def pack_recompute(node, m):
    """The doorbell. Carries a node INDEX into the already-vetted installed graph
    and the batch size, never topology -- the distinction that keeps
    GRAPH_INSTALL's allowlist meaningful."""
    return struct.pack("<II", node, m)


def unpack_recompute(payload):
    if len(payload) != 8:
        raise ProtocolViolation(f"recompute payload is {len(payload)} bytes, want 8")
    return struct.unpack("<II", payload)
