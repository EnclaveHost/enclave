#!/usr/bin/env python3
"""Independent reference for the G-C2 v4 request hash and operation digest (interface sections 2 and 3).
Sia types.Encoder: WriteString/WriteBytes = u64le(len) || bytes; WriteUint64 = u64le; Write = raw bytes.
types.NewHasher = unkeyed BLAKE2b-256."""
import hashlib, struct

def u64(n): return struct.pack('<Q', n)
def s(b): b = b.encode() if isinstance(b, str) else b; return u64(len(b)) + b

CRED = bytes.fromhex("00110000000000010000000000000002" + "ab" * 16 + "000102030405060708090a0b0c0d0e0f")
assert len(CRED) == 48
OP = bytes(range(0x10, 0x20))
HOST, SV = "127.0.0.1:9980", 1800000000

def v4(method, path, flags, sq, body):
    return hashlib.blake2b(s("indexd/fence/v4") + s(method) + s(HOST) + s(path) + u64(SV) + CRED + u64(flags) + u64(sq) + OP + s(body), digest_size=32).hexdigest()

def opd(method, path, flags, sq, body):
    return hashlib.blake2b(s("indexd/fence/v4/op") + s(method) + s(HOST) + s(path) + CRED + u64(flags) + u64(sq) + OP + s(body), digest_size=32).hexdigest()

DEL = "/objects/" + "00" * 32
for method, path, flags, sq, body in [
    ("POST", "/objects", 1, 41, b'{"x":1}'),
    ("DELETE", DEL, 1, 42, b""),
    ("POST", "/slabs/prune", 0, 0, b""),
    # the SDK's request: the R5 vector inputs with sq = 7
    ("DELETE", DEL, 1, 7, b""),
    ("POST", "/objects", 1, 7, b'{"fence":"x"}'),
]:
    print(f"{method} {path} flags={flags} sq={sq} body={body!r}\n  v4 {v4(method, path, flags, sq, body)}\n  op {opd(method, path, flags, sq, body)}")
