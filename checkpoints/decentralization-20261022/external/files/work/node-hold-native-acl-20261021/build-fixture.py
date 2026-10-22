#!/usr/bin/env python3
"""acl-fixture.ps1 = the template with functions.ps1 (from extract.py) inserted VERBATIM between the markers."""
import hashlib, json, pathlib
H = pathlib.Path(__file__).resolve().parent
meta = json.loads((H / "functions.json").read_text()); fn = (H / "functions.ps1").read_text()
assert hashlib.sha256(fn.encode()).hexdigest() == meta["functionsPs1Sha256"]
t = (H / "acl-fixture.template.ps1").read_text()
assert t.count("EXTRACTED_FUNCTIONS") == 1
out = t.replace("FUNCTIONS_SHA", meta["functionsPs1Sha256"]).replace("EXTRACTED_FUNCTIONS\n", fn)
assert fn in out
(H / "acl-fixture.ps1").write_bytes(out.encode("ascii"))     # LF + ASCII, like the helper itself (run from bytes as a scriptblock)
assert fn.encode() in (H / "acl-fixture.ps1").read_bytes(), "the extracted functions are byte-identical inside the fixture"
print("acl-fixture.ps1", hashlib.sha256((H / "acl-fixture.ps1").read_bytes()).hexdigest())
