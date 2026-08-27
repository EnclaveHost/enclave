#!/usr/bin/env python3
"""
protocol.py — the shielded worker's wire contract and admission rules.

This is the reference implementation of the hardened ggml-rpc derivative described
in docs/shielded-inference.md. It is deliberately transport-free and pure: the
same admission logic has to run in the real worker (C++/CUDA) and be testable
here, so everything is a function of bytes-in -> decision, with no sockets.

WHY ggml-rpc CANNOT BE USED AS-IS
---------------------------------
Stock ggml-rpc (proto 5.0.0) is a REMOTE EXECUTION SERVICE. Its GRAPH_COMPUTE
command runs whatever op graph the peer serialises, its GET_TENSOR reads any
region of any live buffer, and it persists tensor payloads to an on-disk cache.
That is a reasonable design for a trusted LAN and a catastrophic one for a worker
that an adversary owns. See GHSA-j8rj-fmpv-wcxw for the memory-safety half of the
same point.

The shielded worker keeps ggml-rpc's framing and allocation plane and replaces its
compute plane:

  GRAPH_COMPUTE  -> GRAPH_INSTALL, accepted once, every node checked against an
                    op allowlist. After install the ONLY compute trigger is
                    GRAPH_RECOMPUTE, which carries no topology.
  GET_TENSOR     -> readable only from tensors an installed graph declared as
                    outputs. Stock behaviour is arbitrary-region read, i.e. full
                    activation exfiltration to whoever holds the socket.
  SET_TENSOR_HASH, COPY_TENSOR, MEMSET_TENSOR, BUFFER_CLEAR, cache_dir -> deleted.

WHAT THIS DOES NOT DO
---------------------
It is not a confidentiality boundary. Confidentiality comes from the masks; the
worker is assumed hostile and is expected to see every byte it is sent. These
rules exist to (a) stop the worker being a general-purpose execution and
exfiltration primitive on the GPU host, and (b) make protocol violations loud
instead of silent. A worker that refuses to follow them is caught by Freivalds
verification in the TEE, not here.

FAIL CLOSED. Every other patch in the wasmtime stack fails open; this one must
not. An unrecognised command, an unlisted op, an out-of-range read, or a
malformed frame terminates the connection. There is no "best effort" path,
because the failure mode of guessing is running an attacker's graph.
"""

import json
import struct

PROTO_VERSION = (1, 2, 0)   # 1.1: FIELD_GEMM, the one-frame exchange; 1.2: FIELD_GEMM24 (packed reply) and SHM_ATTACH (the ring)

# Commands kept from ggml-rpc's allocation plane, plus our two compute verbs.
CMD_HELLO = 0
CMD_ALLOC_BUFFER = 1
CMD_FREE_BUFFER = 2
CMD_BUFFER_GET_BASE = 3
CMD_GET_ALIGNMENT = 4
CMD_GET_MAX_SIZE = 5
CMD_GET_DEVICE_MEMORY = 6
CMD_DEVICE_COUNT = 7
CMD_SET_TENSOR = 8       # weights at load; masked activations at run
CMD_GET_TENSOR = 9       # declared outputs ONLY
CMD_GRAPH_INSTALL = 10   # replaces GRAPH_COMPUTE; allowlisted, install-once
CMD_GRAPH_RECOMPUTE = 11 # the per-step doorbell; no topology
CMD_FIELD_GEMM = 12      # one frame in, one frame out: masked planes -> products
CMD_FIELD_GEMM24 = 13    # the SAME request; the products as 3-byte values (1.2)

# Bytes per product value in a reply. Every product is balanced in
# (-M/2, M/2] with M = 251*241*239 = 14457349 < 2^24, so the 3-byte form
# carries exactly the int32 form's value. It carries nothing else: the
# reply is the same masked products, narrower. A 1.1 peer never sends 13.
REPLY_WIDTH = {CMD_FIELD_GEMM: 4, CMD_FIELD_GEMM24: 3}
CMD_SHM_ATTACH = 14      # 1.2: bind a shared-memory ring to this connection (FIELD_GEMM only)
CMD_COUNT = 15

# The shared-memory ring (wasm/ggml-shielded/shielded-wire.h): a file (the
# ivshmem backing store of the CVM) of SHM_RING_BYTES rings. The ring carries
# FIELD_GEMM frames with the SAME headers as the socket; admission of what
# rides it is _field_gemm, unchanged. The geometry is a protocol constant
# that the TEE checks against its own copy, never adopts.
SHM_RING_BYTES = 8 << 20
SHM_RING_REQ_CAP = (2 << 20) - 4096
SHM_RING_REP_CAP = (8 << 20) - (2 << 20)
SHM_MAX_RINGS = 8

COMMAND_NAMES = {
    CMD_HELLO: "HELLO", CMD_ALLOC_BUFFER: "ALLOC_BUFFER", CMD_FREE_BUFFER: "FREE_BUFFER",
    CMD_BUFFER_GET_BASE: "BUFFER_GET_BASE", CMD_GET_ALIGNMENT: "GET_ALIGNMENT",
    CMD_GET_MAX_SIZE: "GET_MAX_SIZE", CMD_GET_DEVICE_MEMORY: "GET_DEVICE_MEMORY",
    CMD_DEVICE_COUNT: "DEVICE_COUNT", CMD_SET_TENSOR: "SET_TENSOR", CMD_SHM_ATTACH: "SHM_ATTACH",
    CMD_GET_TENSOR: "GET_TENSOR", CMD_GRAPH_INSTALL: "GRAPH_INSTALL",
    CMD_GRAPH_RECOMPUTE: "GRAPH_RECOMPUTE", CMD_FIELD_GEMM: "FIELD_GEMM",
    CMD_FIELD_GEMM24: "FIELD_GEMM24",
}

# Commands that exist in stock ggml-rpc and are deliberately absent here. Named
# explicitly so a future port cannot reintroduce one by accident.
REMOVED_COMMANDS = {
    "SET_TENSOR_HASH": "persists request bytes to an on-disk cache",
    "COPY_TENSOR": "server-side mutation primitive we do not need",
    "MEMSET_TENSOR": "server-side mutation primitive we do not need",
    "BUFFER_CLEAR": "server-side mutation primitive we do not need",
    "GRAPH_COMPUTE": "arbitrary-op execution; replaced by allowlisted GRAPH_INSTALL",
    "INIT_TENSOR": "backend-specific init on attacker-supplied metadata",
    "GET_ALLOC_SIZE": "only meaningful for op types we do not accept",
}

# The ONLY ops a shielded worker will execute. The worker computes masked field
# GEMMs and the metadata reshapes needed to feed them -- nothing else. In
# particular: no softmax, no norms, no activations, no rope, no sampling. Those
# run in the TEE, and a worker that is never asked to do them cannot be coaxed
# into doing them on secret data.
OP_ALLOWLIST = frozenset({
    "FIELD_GEMM",   # residue-plane matmul, the one real compute op
    "VIEW", "RESHAPE", "PERMUTE", "TRANSPOSE", "CONT",  # metadata-only
    "CPY",          # buffer plumbing between the above
})

# Ops that are explicitly refused with a named reason, so the rejection message
# is diagnostic instead of "unknown op".
OP_DENYLIST_REASONS = {
    "SOFT_MAX": "nonlinear on secret data; TEE-only",
    "RMS_NORM": "nonlinear on secret data; TEE-only",
    "NORM": "nonlinear on secret data; TEE-only",
    "SILU": "nonlinear on secret data; TEE-only",
    "GELU": "nonlinear on secret data; TEE-only",
    "ROPE": "consumes token positions; TEE-only",
    "FLASH_ATTN_EXT": "activation-activation product; TwinShield m=1 is broken",
    "MUL_MAT": "plain matmul would run on UNMASKED data; use FIELD_GEMM",
    "ARGSORT": "sampling-adjacent; TEE-only",
    "GET_ROWS": "embedding gather keyed by a secret token id; TEE-only",
}


class ProtocolViolation(Exception):
    """Terminate the connection. Never downgrade to a warning."""


def _u32(b, off):
    if off + 4 > len(b):
        raise ProtocolViolation("truncated u32")
    return struct.unpack_from("<I", b, off)[0], off + 4


def _u64(b, off):
    if off + 8 > len(b):
        raise ProtocolViolation("truncated u64")
    return struct.unpack_from("<Q", b, off)[0], off + 8


def parse_frame(buf):
    """Frame = | cmd u8 | size u64 LE | payload |. Returns (cmd, payload).

    Length is validated against the actual buffer before the payload is touched;
    stock ggml-rpc trusts the declared size in several paths.
    """
    if len(buf) < 9:
        raise ProtocolViolation("frame shorter than header")
    cmd = buf[0]
    size = struct.unpack_from("<Q", buf, 1)[0]
    if cmd >= CMD_COUNT:
        raise ProtocolViolation(f"unknown command {cmd}")
    if size != len(buf) - 9:
        raise ProtocolViolation(f"declared size {size} != actual {len(buf) - 9}")
    return cmd, buf[9:]


def build_frame(cmd, payload=b""):
    return bytes([cmd]) + struct.pack("<Q", len(payload)) + payload


class Buffer:
    __slots__ = ("bid", "size", "role")

    def __init__(self, bid, size, role):
        self.bid = bid
        self.size = size
        self.role = role  # "weights" | "activations"


class InstalledGraph:
    __slots__ = ("nodes", "outputs")

    def __init__(self, nodes, outputs):
        self.nodes = nodes
        self.outputs = outputs  # set of (bid, offset, nbytes) readable by GET_TENSOR


class ShieldedWorkerState:
    """Admission logic for one connection. Pure; no I/O.

    State is per-connection and dies with it: masked activations in VRAM and the
    installed graph. Public weights are the only long-lived residents. A worker
    restart therefore loses nothing secret, which is why crash recovery needs no
    special handling beyond re-uploading weights.
    """

    def __init__(self, vram_bytes=8 << 30, shm_rings=0, ring_owners=None):
        self.hello_done = False
        self.buffers = {}
        self.next_bid = 1
        self.graph = None
        self.vram_bytes = vram_bytes
        self.allocated = 0
        self.violations = []
        # the ring this connection owns (index) or None; ring_owners is the
        # process-wide set of taken indices, shared by every connection
        self.shm_rings = shm_rings
        self.ring_owners = ring_owners if ring_owners is not None else set()
        self.ring = None

    # -- admission ---------------------------------------------------------
    def handle(self, cmd, payload):
        if cmd == CMD_HELLO:
            return self._hello(payload)
        if not self.hello_done:
            raise ProtocolViolation("command before HELLO")
        if cmd == CMD_ALLOC_BUFFER:
            return self._alloc(payload)
        if cmd == CMD_FREE_BUFFER:
            return self._free(payload)
        if cmd == CMD_SET_TENSOR:
            return self._set_tensor(payload)
        if cmd == CMD_GET_TENSOR:
            return self._get_tensor(payload)
        if cmd == CMD_GRAPH_INSTALL:
            return self._graph_install(payload)
        if cmd == CMD_GRAPH_RECOMPUTE:
            return self._graph_recompute(payload)
        if cmd == CMD_FIELD_GEMM:
            return self._field_gemm(payload, CMD_FIELD_GEMM)
        if cmd == CMD_FIELD_GEMM24:
            return self._field_gemm(payload, CMD_FIELD_GEMM24)
        if cmd == CMD_SHM_ATTACH:
            return self._shm_attach(payload)
        if cmd in (CMD_BUFFER_GET_BASE, CMD_GET_ALIGNMENT, CMD_GET_MAX_SIZE,
                   CMD_GET_DEVICE_MEMORY, CMD_DEVICE_COUNT):
            return {"ok": True}
        raise ProtocolViolation(f"unhandled command {cmd}")

    def _hello(self, payload):
        if self.hello_done:
            raise ProtocolViolation("duplicate HELLO")
        major, off = _u32(payload, 0)
        if major != PROTO_VERSION[0]:
            raise ProtocolViolation(f"protocol major {major} != {PROTO_VERSION[0]}")
        self.hello_done = True
        return {"ok": True, "version": PROTO_VERSION}

    def _alloc(self, payload):
        size, off = _u64(payload, 0)
        role_len, off = _u32(payload, off)
        role = payload[off : off + role_len].decode("ascii", "replace")
        if role not in ("weights", "activations"):
            raise ProtocolViolation(f"unknown buffer role {role!r}")
        if self.allocated + size > self.vram_bytes:
            raise ProtocolViolation("allocation exceeds device memory")
        bid = self.next_bid
        self.next_bid += 1
        self.buffers[bid] = Buffer(bid, size, role)
        self.allocated += size
        return {"ok": True, "bid": bid}

    def _free(self, payload):
        bid, _ = _u64(payload, 0)
        buf = self.buffers.pop(bid, None)
        if buf is None:
            raise ProtocolViolation(f"free of unknown buffer {bid}")
        self.allocated -= buf.size
        return {"ok": True}

    def _region_ok(self, bid, offset, nbytes):
        buf = self.buffers.get(bid)
        if buf is None:
            raise ProtocolViolation(f"reference to unknown buffer {bid}")
        # The ggml-rpc memory-safety bug class: a tensor whose buffer is absent or
        # zero skipped bounds validation. Here an unknown buffer is fatal and every
        # region is checked against the real allocation.
        if offset < 0 or nbytes < 0 or offset + nbytes > buf.size:
            raise ProtocolViolation(
                f"region [{offset},{offset + nbytes}) outside buffer {bid} of {buf.size}")
        return buf

    def _set_tensor(self, payload):
        bid, off = _u64(payload, 0)
        offset, off = _u64(payload, off)
        nbytes, off = _u64(payload, off)
        self._region_ok(bid, offset, nbytes)
        return {"ok": True, "wrote": nbytes}

    def _get_tensor(self, payload):
        bid, off = _u64(payload, 0)
        offset, off = _u64(payload, off)
        nbytes, off = _u64(payload, off)
        self._region_ok(bid, offset, nbytes)
        if self.graph is None:
            raise ProtocolViolation("GET_TENSOR before any graph was installed")
        if (bid, offset, nbytes) not in self.graph.outputs:
            # Stock ggml-rpc allows arbitrary-region reads of any live buffer,
            # which is a complete activation read-out for whoever holds the socket.
            raise ProtocolViolation(
                f"GET_TENSOR region ({bid},{offset},{nbytes}) is not a declared graph output")
        return {"ok": True, "read": nbytes}

    def _graph_install(self, payload):
        if self.graph is not None:
            raise ProtocolViolation("graph already installed; reconnect to replace")
        try:
            spec = json.loads(payload.decode("utf-8"))
        except Exception as e:
            raise ProtocolViolation(f"malformed graph spec: {e}")
        nodes = spec.get("nodes")
        if not isinstance(nodes, list) or not nodes:
            raise ProtocolViolation("graph spec has no nodes")
        for i, n in enumerate(nodes):
            op = n.get("op")
            if op in OP_DENYLIST_REASONS:
                raise ProtocolViolation(
                    f"node {i}: op {op} refused ({OP_DENYLIST_REASONS[op]})")
            if op not in OP_ALLOWLIST:
                raise ProtocolViolation(f"node {i}: op {op!r} not in allowlist")
        outputs = set()
        for o in spec.get("outputs", []):
            bid, offset, nbytes = o["bid"], o["offset"], o["nbytes"]
            self._region_ok(bid, offset, nbytes)
            outputs.add((bid, offset, nbytes))
        if not outputs:
            raise ProtocolViolation("graph declares no outputs; nothing could be read back")
        self.graph = InstalledGraph(nodes, outputs)
        return {"ok": True, "nodes": len(nodes), "outputs": len(outputs)}

    def _graph_recompute(self, payload):
        if self.graph is None:
            raise ProtocolViolation("RECOMPUTE with no installed graph")
        return {"ok": True, "nodes": len(self.graph.nodes)}

    def _field_gemm(self, payload, cmd=CMD_FIELD_GEMM):
        """| n u32 | m u32 | node u32[n] | planes int8[3][m][K] | -> the products of
        exactly those nodes, in order. Every node must be an installed
        FIELD_GEMM sharing one K (they share the activation), and the payload
        must be exactly the size the header implies. The reply is defined by
        the request, so there is nothing for GET_TENSOR's declared-output rule
        to gate: a worker cannot be asked for any region it did not compute.

        The reply's SIZE is defined by the request too: REPLY_WIDTH[cmd] * m * N
        bytes per node, in request order -- int32 for FIELD_GEMM, 3-byte
        little-endian two's complement for FIELD_GEMM24. The TEE checks the
        length it receives against this rule and treats any other length as a
        lying peer; `reply_bytes` below is that rule."""
        if self.graph is None:
            raise ProtocolViolation("FIELD_GEMM with no installed graph")
        n, off = _u32(payload, 0)
        m, off = _u32(payload, off)
        if n < 1 or n > 64:
            raise ProtocolViolation(f"FIELD_GEMM names {n} nodes")
        ids = []
        for _ in range(n):
            i, off = _u32(payload, off)
            ids.append(i)
        K = None
        for i in ids:
            if i >= len(self.graph.nodes):
                raise ProtocolViolation(f"FIELD_GEMM of node {i}, graph has {len(self.graph.nodes)}")
            node = self.graph.nodes[i]
            if node.get("op") != "FIELD_GEMM":
                raise ProtocolViolation(f"node {i} is metadata-only; nothing to compute")
            k = int(node.get("K", 0))
            if K is None:
                K = k
            elif k != K:
                raise ProtocolViolation("FIELD_GEMM nodes disagree on K")
            if m < 1 or m > int(node.get("max_m", 0)):
                raise ProtocolViolation(f"m={m} outside [1,{node.get('max_m')}] for node {i}")
        want = off + 3 * m * K
        if len(payload) != want:
            raise ProtocolViolation(f"FIELD_GEMM payload is {len(payload)} bytes, expected {want}")
        reply_bytes = sum(REPLY_WIDTH[cmd] * m * int(self.graph.nodes[i]["N"]) for i in ids)
        return {"ok": True, "nodes": ids, "m": m, "K": K, "planes_at": off,
                "width": REPLY_WIDTH[cmd], "reply_bytes": reply_bytes}


    def _shm_attach(self, payload):
        """| ring u32 | -> granted + the ring geometry. Needs an installed graph
        (only FIELD_GEMM rides the ring), one ring per connection, one
        connection per ring. NOT granted is an answer, not a violation: the
        link keeps the socket. The reply's geometry is the protocol constant."""
        if self.graph is None:
            raise ProtocolViolation("SHM_ATTACH before GRAPH_INSTALL")
        if self.ring is not None:
            raise ProtocolViolation("duplicate SHM_ATTACH")
        index, _ = _u32(payload, 0)
        granted = index < self.shm_rings and index < SHM_MAX_RINGS and index not in self.ring_owners
        if granted:
            self.ring_owners.add(index)
            self.ring = index
        return {"ok": True, "granted": granted, "ring_bytes": SHM_RING_BYTES,
                "req_cap": SHM_RING_REQ_CAP, "rep_cap": SHM_RING_REP_CAP}

    def release(self):
        """Connection closed: the ring (if any) is free for the next link."""
        if self.ring is not None:
            self.ring_owners.discard(self.ring)
            self.ring = None


def pack_int24(values):
    """The FIELD_GEMM24 reply encoding of a sequence of balanced products:
    3 bytes each, little-endian two's complement. Refuses a value the field
    cannot have produced rather than truncating it."""
    out = bytearray(3 * len(values))
    for i, v in enumerate(values):
        v = int(v)
        if v < -(1 << 23) or v >= (1 << 23):
            raise ProtocolViolation(f"product {v} does not fit int24")
        b = v.to_bytes(4, "little", signed=True)
        out[3 * i : 3 * i + 3] = b[:3]
    return bytes(out)


def unpack_int24(buf):
    if len(buf) % 3:
        raise ProtocolViolation(f"packed reply of {len(buf)} bytes is not a whole number of values")
    return [int.from_bytes(buf[i : i + 3], "little", signed=True) for i in range(0, len(buf), 3)]

def selftest():
    """Exercised by test/shielded-protocol.test.mjs."""
    out = {}

    st = ShieldedWorkerState()
    # commands before HELLO are refused
    try:
        st.handle(*parse_frame(build_frame(CMD_ALLOC_BUFFER, struct.pack("<Q", 16) + struct.pack("<I", 7) + b"weights")))
        out["pre_hello_refused"] = False
    except ProtocolViolation:
        out["pre_hello_refused"] = True

    st.handle(*parse_frame(build_frame(CMD_HELLO, struct.pack("<I", 1))))
    out["hello_ok"] = st.hello_done

    def alloc(size, role):
        p = struct.pack("<Q", size) + struct.pack("<I", len(role)) + role.encode()
        return st.handle(*parse_frame(build_frame(CMD_ALLOC_BUFFER, p)))["bid"]

    wbid = alloc(1 << 20, "weights")
    abid = alloc(1 << 16, "activations")
    out["alloc_ok"] = wbid == 1 and abid == 2

    # out-of-range writes are fatal
    try:
        st.handle(*parse_frame(build_frame(
            CMD_SET_TENSOR, struct.pack("<QQQ", abid, (1 << 16) - 8, 64))))
        out["oob_write_refused"] = False
    except ProtocolViolation:
        out["oob_write_refused"] = True

    # a graph containing a denied op is refused, with a reason
    bad = json.dumps({"nodes": [{"op": "FIELD_GEMM"}, {"op": "SOFT_MAX"}],
                      "outputs": [{"bid": abid, "offset": 0, "nbytes": 256}]}).encode()
    try:
        st.handle(*parse_frame(build_frame(CMD_GRAPH_INSTALL, bad)))
        out["denied_op_refused"] = False
        out["denied_op_reason"] = None
    except ProtocolViolation as e:
        out["denied_op_refused"] = True
        out["denied_op_reason"] = str(e)

    # plain MUL_MAT is refused: it would run on unmasked data
    bad2 = json.dumps({"nodes": [{"op": "MUL_MAT"}],
                       "outputs": [{"bid": abid, "offset": 0, "nbytes": 256}]}).encode()
    try:
        st.handle(*parse_frame(build_frame(CMD_GRAPH_INSTALL, bad2)))
        out["mul_mat_refused"] = False
    except ProtocolViolation:
        out["mul_mat_refused"] = True

    good = json.dumps({
        "nodes": [{"op": "FIELD_GEMM"}, {"op": "VIEW"}, {"op": "CPY"}],
        "outputs": [{"bid": abid, "offset": 0, "nbytes": 256}],
    }).encode()
    r = st.handle(*parse_frame(build_frame(CMD_GRAPH_INSTALL, good)))
    out["good_graph_installed"] = r["ok"] and r["nodes"] == 3

    # reads outside declared outputs are refused
    try:
        st.handle(*parse_frame(build_frame(CMD_GET_TENSOR, struct.pack("<QQQ", abid, 512, 64))))
        out["undeclared_read_refused"] = False
    except ProtocolViolation:
        out["undeclared_read_refused"] = True

    r = st.handle(*parse_frame(build_frame(CMD_GET_TENSOR, struct.pack("<QQQ", abid, 0, 256))))
    out["declared_read_ok"] = r["ok"]

    # recompute is the only compute trigger after install
    out["recompute_ok"] = st.handle(*parse_frame(build_frame(CMD_GRAPH_RECOMPUTE, b"")))["ok"]

    # the one-frame exchange: refused before install (on a fresh state), sized exactly
    st2 = ShieldedWorkerState()
    st2.handle(*parse_frame(build_frame(CMD_HELLO, struct.pack("<I", 1))))
    try:
        st2.handle(*parse_frame(build_frame(CMD_FIELD_GEMM, struct.pack("<II", 1, 1) + struct.pack("<I", 0) + bytes(96))))
        out["gemm_before_install_refused"] = False
    except ProtocolViolation:
        out["gemm_before_install_refused"] = True
    wb2 = st2.handle(*parse_frame(build_frame(CMD_ALLOC_BUFFER, struct.pack("<Q", 1 << 16) + struct.pack("<I", 7) + b"weights")))["bid"]
    ab2 = st2.handle(*parse_frame(build_frame(CMD_ALLOC_BUFFER, struct.pack("<Q", 1 << 16) + struct.pack("<I", 11) + b"activations")))["bid"]
    spec = json.dumps({
        "nodes": [{"op": "FIELD_GEMM", "w": {"bid": wb2, "offset": 0}, "x": {"bid": ab2, "offset": 0},
                   "y": {"bid": ab2, "offset": 1024}, "K": 32, "N": 4, "max_m": 2}],
        "outputs": [{"bid": ab2, "offset": 1024, "nbytes": 16}],
    }).encode()
    st2.handle(*parse_frame(build_frame(CMD_GRAPH_INSTALL, spec)))
    r = st2.handle(*parse_frame(build_frame(CMD_FIELD_GEMM, struct.pack("<II", 1, 2) + struct.pack("<I", 0) + bytes(3 * 2 * 32))))
    out["gemm_ok"] = r["ok"] and r["m"] == 2 and r["K"] == 32 and r["reply_bytes"] == 4 * 2 * 4
    # 1.2: the packed form takes the identical request and defines a reply of
    # 3 bytes per product; a value outside int24 is refused, never truncated;
    # pack/unpack round-trip the field's whole balanced range.
    r = st2.handle(*parse_frame(build_frame(CMD_FIELD_GEMM24, struct.pack("<II", 1, 2) + struct.pack("<I", 0) + bytes(3 * 2 * 32))))
    out["gemm24_ok"] = r["ok"] and r["m"] == 2 and r["K"] == 32 and r["width"] == 3 and r["reply_bytes"] == 3 * 2 * 4
    try:
        st2.handle(*parse_frame(build_frame(CMD_FIELD_GEMM24, struct.pack("<II", 1, 2) + struct.pack("<I", 0) + bytes(3 * 2 * 32 - 1))))
        out["gemm24_short_refused"] = False
    except ProtocolViolation:
        out["gemm24_short_refused"] = True
    M = 251 * 241 * 239
    probe = [0, 1, -1, M // 2, -(M // 2), 12345, -8388608, 8388607]
    out["int24_roundtrip"] = unpack_int24(pack_int24(probe)) == probe and pack_int24([1, -2]) == b"\x01\x00\x00\xfe\xff\xff"
    try:
        pack_int24([1 << 23])
        out["int24_overflow_refused"] = False
    except ProtocolViolation:
        out["int24_overflow_refused"] = True
    try:
        st2.handle(*parse_frame(build_frame(CMD_FIELD_GEMM, struct.pack("<II", 1, 2) + struct.pack("<I", 0) + bytes(3 * 2 * 32 - 1))))
        out["gemm_short_refused"] = False
    except ProtocolViolation:
        out["gemm_short_refused"] = True
    try:
        st2.handle(*parse_frame(build_frame(CMD_FIELD_GEMM, struct.pack("<II", 1, 3) + struct.pack("<I", 0) + bytes(3 * 3 * 32))))
        out["gemm_over_max_m_refused"] = False
    except ProtocolViolation:
        out["gemm_over_max_m_refused"] = True

    # a second install on the same connection is refused
    try:
        st.handle(*parse_frame(build_frame(CMD_GRAPH_INSTALL, good)))
        out["reinstall_refused"] = False
    except ProtocolViolation:
        out["reinstall_refused"] = True

    # framing: a lying length header is fatal
    try:
        parse_frame(bytes([CMD_HELLO]) + struct.pack("<Q", 999) + b"\x01")
        out["bad_length_refused"] = False
    except ProtocolViolation:
        out["bad_length_refused"] = True

    try:
        parse_frame(build_frame(CMD_COUNT + 5, b""))
        out["unknown_cmd_refused"] = False
    except ProtocolViolation:
        out["unknown_cmd_refused"] = True

    # shm ring: refused before a graph is installed, granted once per ring,
    # and a second connection asking for the same ring is told no (not killed)
    owners = set()
    s3 = ShieldedWorkerState(shm_rings=2, ring_owners=owners)
    s3.handle(*parse_frame(build_frame(CMD_HELLO, struct.pack("<I", 1))))
    try:
        s3.handle(*parse_frame(build_frame(CMD_SHM_ATTACH, struct.pack("<I", 0))))
        out["shm_attach_before_install_refused"] = False
    except ProtocolViolation:
        out["shm_attach_before_install_refused"] = True
    r = st.handle(*parse_frame(build_frame(CMD_SHM_ATTACH, struct.pack("<I", 0))))
    out["shm_attach_without_rings_not_granted"] = (r["granted"] is False
                                                   and r["ring_bytes"] == SHM_RING_BYTES)
    s4 = ShieldedWorkerState(shm_rings=2, ring_owners=owners)
    s4.handle(*parse_frame(build_frame(CMD_HELLO, struct.pack("<I", 1))))
    for bid_size, role in ((4096, "weights"), (4096, "activations")):
        s4.handle(*parse_frame(build_frame(CMD_ALLOC_BUFFER, struct.pack("<QI", bid_size, len(role)) + role.encode())))
    s4.handle(*parse_frame(build_frame(CMD_GRAPH_INSTALL, good)))
    out["shm_attach_granted"] = s4.handle(*parse_frame(build_frame(CMD_SHM_ATTACH, struct.pack("<I", 1))))["granted"] is True
    s5 = ShieldedWorkerState(shm_rings=2, ring_owners=owners)
    s5.handle(*parse_frame(build_frame(CMD_HELLO, struct.pack("<I", 1))))
    for bid_size, role in ((4096, "weights"), (4096, "activations")):
        s5.handle(*parse_frame(build_frame(CMD_ALLOC_BUFFER, struct.pack("<QI", bid_size, len(role)) + role.encode())))
    s5.handle(*parse_frame(build_frame(CMD_GRAPH_INSTALL, good)))
    out["shm_taken_ring_not_granted"] = s5.handle(*parse_frame(build_frame(CMD_SHM_ATTACH, struct.pack("<I", 1))))["granted"] is False
    s4.release()
    out["shm_ring_released"] = s5.handle(*parse_frame(build_frame(CMD_SHM_ATTACH, struct.pack("<I", 1))))["granted"] is True
    try:
        s5.handle(*parse_frame(build_frame(CMD_SHM_ATTACH, struct.pack("<I", 0))))
        out["shm_duplicate_attach_refused"] = False
    except ProtocolViolation:
        out["shm_duplicate_attach_refused"] = True

    out["removed_commands"] = sorted(REMOVED_COMMANDS)
    out["op_allowlist"] = sorted(OP_ALLOWLIST)
    out["ok"] = all(v for k, v in out.items()
                    if isinstance(v, bool))
    return out


if __name__ == "__main__":
    print(json.dumps(selftest(), separators=(",", ":")))
