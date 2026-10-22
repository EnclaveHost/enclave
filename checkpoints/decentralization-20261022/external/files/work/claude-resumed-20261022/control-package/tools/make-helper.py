#!/usr/bin/env python3
"""helper/root-node-hold.py = tools/helper-head.py + the VERBATIM remote texts of root-node-hold.py 0829847e (its lines 64-127,
minus the single-call FIL text that batched hashing replaces) + tools/helper-body.py; then pins manifest.json's sha."""
import hashlib, pathlib
P = pathlib.Path(__file__).resolve().parents[1]; H = P / "helper"
base = (H / "root-node-hold.base-0829847e.py").read_bytes()
assert hashlib.sha256(base).hexdigest() == "0829847e90cd090948af9e74ca053045aef4e630193881ce2a48e3e54947cd02"
lines = base.decode().splitlines(keepends=True)[63:127]
fil = [l for l in lines if l.startswith("FIL = ")]; assert len(fil) == 1
texts = "".join(l for l in lines if not l.startswith("FIL = "))
assert texts.startswith("# ----") and "JOURNAL = U +" in texts and "LAUNCH = U +" in texts
s = (P / "tools/helper-head.py").read_text() + texts + (P / "tools/helper-body.py").read_text()
s = s.replace('"MANIFEST_SHA_PIN"', '"' + hashlib.sha256((P / "manifest.json").read_bytes()).hexdigest() + '"', 1)
(H / "root-node-hold.py").write_text(s); print("helper", hashlib.sha256(s.encode()).hexdigest())
