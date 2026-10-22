#!/usr/bin/env python3
"""Compose helper/node-policy-activation.ps1 from helper/src/node-policy-activation.template.ps1 and the ROOT-ACCEPTED rpc-integrated
coordinator (base/node-hold-cutover.ps1 df2e58f2 = work/root-control-rpc-final-20261022/control-package/helper/node-hold-cutover.ps1).
Every "#@BASE a-b" line of the template is replaced by base lines a..b byte for byte; "@GATE_JS_SHA@" by the sha256 of
gate/gate-proof.mjs. Writes helper/node-policy-activation.ps1 and helper/compose.json (what was reused, and the output sha)."""
import hashlib, json, pathlib, re, sys
H = pathlib.Path(__file__).resolve().parent; A = H.parent
BASE = (A / "base/node-hold-cutover.ps1", "df2e58f2569d04b2021a570d8525769ef84976335d2c2657e7e2a3a92604a5d8")
FROZEN = A.parents[3] / "root-control-rpc-final-20261022/control-package/helper/node-hold-cutover.ps1"   # platform-carrier/activation depth
sha = lambda b: hashlib.sha256(b).hexdigest()

def main():
    b = BASE[0].read_bytes()
    if sha(b) != BASE[1]: raise SystemExit("base is not the root-accepted df2e58f2")
    if FROZEN.exists() and sha(FROZEN.read_bytes()) != BASE[1]: raise SystemExit("the frozen package's coordinator differs from the base copy")
    base = b.decode("utf-8").split("\n")
    js = (A / "gate/gate-proof.mjs").read_bytes()
    if any(c > 127 for c in js): raise SystemExit("gate-proof.mjs must be ASCII (it is written to node.exe stdin)")
    out, used = [], []
    for line in (H / "src/node-policy-activation.template.ps1").read_text().split("\n"):
        m = re.fullmatch(r"#@BASE (\d+)-(\d+)", line)
        if m:
            a, z = int(m.group(1)), int(m.group(2)); out.extend(base[a - 1:z]); used.append([a, z]); continue
        out.append(line.replace("@GATE_JS_SHA@", sha(js)))
    text = "\n".join(out)
    if "@GATE_JS_SHA@" in text or re.search(r"(?m)^#@BASE", text): raise SystemExit("unreplaced marker")
    if "\r" in text: raise SystemExit("CR in the composed script")
    p = H / "node-policy-activation.ps1"; p.write_bytes(text.encode("utf-8"))
    rec = {"base": {"path": "base/node-hold-cutover.ps1", "sha256": BASE[1]}, "baseLines": used,
           "template": sha((H / "src/node-policy-activation.template.ps1").read_bytes()), "gateProof": sha(js),
           "output": {"path": "helper/node-policy-activation.ps1", "sha256": sha(text.encode()), "lines": len(out)}}
    (H / "compose.json").write_text(json.dumps(rec, indent=1) + "\n"); print(json.dumps(rec, indent=1))

if __name__ == "__main__": main()
