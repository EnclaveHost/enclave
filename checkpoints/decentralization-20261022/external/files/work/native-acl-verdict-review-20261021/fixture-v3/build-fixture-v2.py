#!/usr/bin/env python3
"""acl-fixture-v2.ps1 = the v2 template with functions.ps1 (38dc1a39, unchanged) inserted VERBATIM."""
import hashlib, json, pathlib
H = pathlib.Path(__file__).resolve().parent
meta = json.loads((H / "functions.json").read_text()); fn = (H / "functions.ps1").read_text()
assert hashlib.sha256(fn.encode()).hexdigest() == meta["functionsPs1Sha256"] == "38dc1a39d90576d94e5e903079db8c4e00742499f9819995e703d5d4a699b618"
t = (H / "acl-fixture.template.ps1").read_text(); assert t.count("EXTRACTED_FUNCTIONS") == 1
out = t.replace("FUNCTIONS_SHA", meta["functionsPs1Sha256"]).replace("EXTRACTED_FUNCTIONS\n", fn)
(H / "acl-fixture.ps1").write_bytes(out.encode("ascii")); assert fn.encode() in (H / "acl-fixture.ps1").read_bytes()
print("acl-fixture.ps1", hashlib.sha256((H / "acl-fixture.ps1").read_bytes()).hexdigest())
