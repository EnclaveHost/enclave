#!/usr/bin/env python3
"""Independent computation of the G-C2 v4.0 request hash and operation digest (work/indexd-c2-implementation-interface.txt
sections 2-3), for the SDK's self-vectors. hashlib BLAKE2b-256; sia types.Encoder: WriteString = u64le(len) || bytes."""
import hashlib, struct
def u64(n): return struct.pack("<Q", n)
def ws(b): return u64(len(b)) + b
token = bytes.fromhex("0011000000000001" + "0000000000000002") + bytes([0xab]*16)
receipt = bytes(range(16))
cred = token + receipt
op = bytes(range(16, 32))
SV = 1_800_000_000
def v4_hash(method, host, path, flags, sq, body):
    return hashlib.blake2b(ws(b"indexd/fence/v4") + ws(method) + ws(host) + ws(path) + u64(SV) + cred + u64(flags) + u64(sq) + op + ws(body), digest_size=32).hexdigest()
def op_digest(method, host, path, flags, sq, body):
    return hashlib.blake2b(ws(b"indexd/fence/v4/op") + ws(method) + ws(host) + ws(path) + cred + u64(flags) + u64(sq) + op + ws(body), digest_size=32).hexdigest()
host = b"127.0.0.1:9980"
zeros = b"/objects/" + b"00" * 32
post_body = b'{"fence":"x"}'
out = {
  "cred": cred.hex(), "op": op.hex(), "sv": SV,
  "v4 POST /objects sq=7": v4_hash(b"POST", host, b"/objects", 1, 7, post_body),
  "v4 DELETE /objects/00.. sq=7": v4_hash(b"DELETE", host, zeros, 1, 7, b""),
  "v4 POST /slabs no sq": v4_hash(b"POST", host, b"/slabs", 0, 0, b"[]"),
  "opDigest POST /objects sq=7": op_digest(b"POST", host, b"/objects", 1, 7, post_body),
  "opDigest DELETE /objects/00.. sq=7": op_digest(b"DELETE", host, zeros, 1, 7, b""),
}
for k, v in out.items(): print(f"{k}: {v}")
