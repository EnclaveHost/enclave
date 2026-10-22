#!/usr/bin/env python3
"""(Re)pin root-node-hold.py on the files it names: the host.mjs candidate and node-hold-cutover.ps1."""
import hashlib, pathlib, re
H = pathlib.Path(__file__).resolve().parent; P = H.parent
sha = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()
s = (H / "root-node-hold.py").read_text()
s, n1 = re.subn(r'("node-hold-cutover.ps1": \(HERE / "node-hold-cutover.ps1", )"[0-9a-fA-F_A-Z]+"', lambda m: m.group(1) + '"' + sha(H / "node-hold-cutover.ps1") + '"', s)
s, n2 = re.subn(r'("c4629529903ee87edd258fb5b1964525bcf29b3a1109d9f0c30e74b06d05cfd0", )"[0-9a-fA-F_A-Z]+"', lambda m: m.group(1) + '"' + sha(P / "control/new/host.mjs") + '"', s)
assert n1 == 1 and n2 == 1, (n1, n2)
(H / "root-node-hold.py").write_text(s); print("cutover", sha(H / "node-hold-cutover.ps1")[:12], "host", sha(P / "control/new/host.mjs")[:12])
