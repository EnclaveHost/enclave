#!/usr/bin/env python3
"""Offline self-check of interop.py's streamed fixture-body helpers (no services): the chunked body, its sha256 and
length, ranged slices and multipart expectations equal the whole-buffer computation. Loads ONLY those definitions."""
import ast, hashlib, random, sys
src = open(sys.argv[1]).read()
names = {"data_iter", "data", "Body", "data_slice", "expected_parts", "expected_digest", "expected_slice", "Sink"}
mod = ast.Module(body=[n for n in ast.parse(src).body if (isinstance(n, (ast.FunctionDef, ast.ClassDef)) and n.name in names)
                       or (isinstance(n, ast.Assign) and any(getattr(t, "id", "") in ("CHUNK", "DIGESTS") for t in n.targets))], type_ignores=[])
g = {"hashlib": hashlib, "random": random, "run_id": "selftest", "sha": lambda b: hashlib.sha256(b).hexdigest()}
exec(compile(mod, "helpers", "exec"), g)
MIB = 1 << 20
ok = 0
for tag, n in (("x", 1), ("y", 1024), ("z", MIB), ("w", MIB + 7), ("big", 48 * MIB)):
    whole = g["data"](tag, n)
    b = g["Body"](tag, n)
    assert len(whole) == n and b.n == n and b.sha == hashlib.sha256(whole).hexdigest() and b"".join(iter(b)) == whole, tag
    for a, z in ((0, min(100, n)), (max(n - 1000, 0), n), (n // 2, n // 2 + 1), (max(n - 5000, 0), max(n - 4000, 1))):
        assert g["data_slice"](tag, n, a, z) == whole[a:z], (tag, a, z)
    if n > 40 * MIB + 10:
        assert g["data_slice"](tag, n, 40 * MIB - 10, 40 * MIB + 10) == whole[40 * MIB - 10:40 * MIB + 10]
    ok += 1
mp = "mp:p1:%d+p2:%d" % (5 * MIB, MIB)
whole = g["data"]("p1", 5 * MIB) + g["data"]("p2", MIB)
assert g["expected_digest"](mp, 6 * MIB) == hashlib.sha256(whole).hexdigest()
for a, z in ((0, 100), (5 * MIB - 10, 5 * MIB + 10), (6 * MIB - 1000, 6 * MIB)):
    assert g["expected_slice"](mp, 6 * MIB, a, z) == whole[a:z]
assert g["expected_digest"]("big", 48 * MIB) == hashlib.sha256(g["data"]("big", 48 * MIB)).hexdigest()
print(f"SELFCHECK OK: {ok} bodies + multipart + digests")
