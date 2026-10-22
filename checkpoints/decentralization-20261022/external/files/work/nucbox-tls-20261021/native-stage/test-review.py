#!/usr/bin/env python3
"""Root review points of root-activate.py: local unit tests (subprocess/ps patched, nothing remote) + ONE native negative
parse (a deliberately broken text uploaded to the staging dir must be reported as a parse failure)."""
import importlib.util, json, os, sys, types
HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("ra", os.path.join(HERE, "..", "root-activate.py"))
ra = importlib.util.module_from_spec(spec); spec.loader.exec_module(ra)
import tempfile; os.chdir(tempfile.mkdtemp(prefix="ra-unit-"))   # the unit runs' receipts go to a scratch dir, never next to real ones
R, fails = {}, []
def check(label, cond, detail=None):
    R[label] = bool(cond)
    if not cond: fails.append(label); print("FAIL", label, detail)

# 1. ps(): an ssh failure, missing or unparsable output is always an "error"
real_run = ra.subprocess.run
def fake(rc, out):
    return lambda *a, **k: types.SimpleNamespace(returncode=rc, stdout=out, stderr="e")
for rc, out, want_err, label in ((255, "", True, "ssh failed, no output"), (0, "garbage", True, "unparsable output"),
                                 (1, '{"a":1}', True, "JSON but ssh rc 1"), (0, '{"a":1}', False, "clean")):
    ra.subprocess.run = fake(rc, out); res = ra.ps("$x=1")
    check(f"ps(): {label} -> {'error' if want_err else 'ok'}", ("error" in res) == want_err, res)
ra.subprocess.run = real_run

# 2. parse_ok
check("parse_ok: clean", ra.parse_ok({"parseErrors": [], "encodedChars": 6000, "sha256": "x"}))
for v, label in (({"error": "upload failed"}, "error"), ({"parseErrors": ["x"], "encodedChars": 10}, "parse error"),
                 ({}, "missing fields"), (None, "no result"), ({"parseErrors": [], "encodedChars": 9000}, "too long")):
    check(f"parse_ok rejects: {label}", not ra.parse_ok(v), v)

# 3/4. main(): --parse-only propagates a failure; --execute needs BOTH node checks before any restart
F = ra.FILES
pre_ok = {"wmiserve-run.mjs": {"live": F["wmiserve-run.mjs"]["live"], "candidate": F["wmiserve-run.mjs"]["new"]},
          "server.mjs": {"live": F["server.mjs"]["live"], "candidate": F["server.mjs"]["new"]}, "manager": {"ok": True}}
calls = []
def fake_ps(install_result):
    def ps(script, secs=150):
        calls.append(script)
        if "Stop-Process" in script: return {"RESTART": "called"}
        if "$o.manager=Mgr" in script: return dict(pre_ok)
        if "--check $c" in script: return [0, 0]
        return install_result
    return ps
real_ps, real_pr = ra.ps, ra.parse_remote
ra.ps = fake_ps({})
ra.parse_remote = lambda name, text: {"parseErrors": [], "encodedChars": 6000} if name != "rollback-restart" else {"error": "no output (ssh rc 255)"}
check("--parse-only: one failed script -> non-zero", ra.main(["--parse-only"]) == 6)
ra.parse_remote = lambda name, text: {"parseErrors": [], "encodedChars": 6000}
check("--parse-only: all clean -> 0", ra.main(["--parse-only"]) == 0)
good = {"wmiserve-run.mjs": F["wmiserve-run.mjs"]["new"], "server.mjs": F["server.mjs"]["new"], "nodeCheckWmiserve": 0}
for extra, label in (({"nodeCheckServer": 1}, "nodeCheckServer 1"), ({}, "nodeCheckServer missing"), ({"nodeCheckServer": 0, "error": "ssh rc 1"}, "install errored")):
    calls.clear(); ra.ps = fake_ps({**good, **extra})
    rc = ra.main(["--execute"])
    check(f"--execute: {label} -> stopped before restart (rc 4)", rc == 4 and all("Stop-Process" not in c for c in calls), rc)
calls.clear(); ra.ps = fake_ps({**good, "nodeCheckServer": 0})
rc = ra.main(["--execute"])
check("--execute: both node checks 0 -> the restart step runs", any("Stop-Process" in c for c in calls), len(calls))
ra.ps, ra.parse_remote = real_ps, real_pr

# 5. native negative: a broken text is reported as a parse failure (staging dir only)
neg = ra.parse_remote("negative-broken", "if( {")
check("native: a broken script is a parse FAILURE", not ra.parse_ok(neg) and neg.get("parseErrors"), neg)
print(json.dumps(R, indent=1)); print(f"{len(R) - len(fails)}/{len(R)} PASS" + (f"; FAILED {fails}" if fails else ""))
sys.exit(1 if fails else 0)
