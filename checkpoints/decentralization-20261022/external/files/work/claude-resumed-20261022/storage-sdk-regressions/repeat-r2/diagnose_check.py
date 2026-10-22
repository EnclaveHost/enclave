#!/usr/bin/env python3
"""repeat-r2 diagnosis, checked offline against EXISTING evidence and sources (read-only; nothing is run or rebuilt).
  D1 feindexd: `real_bootstrap_after_an_acknowledged_but_unpublished_pin` (feed/"v060" mode) failed ONLY at its
     stock-only final check `load_listing(.., Listing::Current).err().expect("no current listing on stock indexd")`
     (real_indexd.rs:376). Both accepted enclave trees carry PATCH U1 (`GET /current/objects`); stock v0.6.0 does
     not. Every feed-mode assertion before it held (the feed missed the acknowledged PUT; the documented feed defect
     reproduced). The other 6 feindexd cases passed.
  D2 c2eindexd: the harness stopped in setup: `indexer r0 formed 11 of 12 contracts` after its fixed 3-minute
     waitContracts bound. It ran with -hosts 12 == need (no spare host). Every other group formed 12/12 within 2-4 s.
     The same flake (`v060a`) was fixed in storage-real-indexd by running 14 hosts (12 needed)."""
import json, pathlib, re, sys
W = pathlib.Path("/home/steven/Documents/Codex/2026-10-18/wo/work"); C = W / "claude-resumed-20261022"
R = C / "storage-sdk-regressions" / "runs" / "20261022T074318-2c83b92890fa-results"
SNAP = W / "indexd-c2-implementation" / "sdk-snapshot-c2-4" / "sia-s3" / "src" / "real_indexd.rs"
H = C / "storage-sdk-regressions" / "harness-src" / "cmd" / "harness-block" / "main.go"
checks = []
def check(name, ok, detail=""): checks.append({"check": name, "ok": bool(ok), "detail": detail}); print(("OK   " if ok else "FAIL ") + name + (f" :: {detail}" if detail else ""))
src = SNAP.read_text().splitlines()
check("D1 real_indexd.rs:376 is the stock-only expect", 'expect("no current listing on stock indexd")' in src[375], src[375].strip()[:110])
log = (R / "feindexd" / "driver.log").read_text()
check("D1 feindexd panicked exactly there", "panicked at src/real_indexd.rs:376:85:\nno current listing on stock indexd" in log)
check("D1 feed missed the acknowledged PUT before it", 'EVIDENCE boot-while-unpublished {"indexd":"v060","kSeen":null,"listing":"Feed"}' in log)
check("D1 feed defect reproduced before it", 'EVIDENCE acknowledged-delete-undone {"deleteRecorded":false,"kAfterPublication":"v2"}' in log)
check("D1 feindexd summary 6 passed / 1 failed", "test result: FAILED. 6 passed; 1 failed;" in log)
for t in ("fence-enclave", "c2-enclave"):
    app = (C / "storage-funding-test-fix" / "snapshots" / t / "api" / "app" / "app.go").read_text()
    check(f"D1 {t} serves GET /current/objects (PATCH U1)", '"GET /current/objects": wrapSignedAuth(a.handleGETCurrentObjects)' in app)
check("D1 stock v0.6.0 (work/indexd) does NOT serve it", "current/objects" not in (W / "indexd" / "api" / "app" / "app.go").read_text())
check("D2 c2eindexd harness stopped in setup", (R / "c2eindexd" / "c2eindexd.harness.log").read_text().strip() == "setup failed: indexer r0 formed 11 of 12 contracts")
ev = [json.loads(l) for l in (R / "c2eindexd" / "events.jsonl").read_text().splitlines() if l.strip()]
check("D2 12 hosts created and announced to all 3 indexers", sum(e["event"] == "host-created" for e in ev) == 12 and sum(e["event"] == "hosts-announced" and e.get("known") == 12 for e in ev) == 3)
check("D2 no contracts-formed event in c2eindexd", not any(e["event"] == "contracts-formed" for e in ev))
others = [g for g in R.iterdir() if g.is_dir() and g.name != "c2eindexd"]
formed = all(sum(json.loads(l)["event"] == "contracts-formed" for l in (g / "events.jsonl").read_text().splitlines() if l.strip()) == 3 for g in others)
check("D2 every other group formed contracts on all 3 indexers", formed, ", ".join(sorted(g.name for g in others)))
h = H.read_text()
check("D2 waitContracts bound is a fixed 3 minutes, mining every 10 s", "time.Since(start) > 3*time.Minute" in h and "time.Since(lastMine) > 10*time.Second" in h)
cg = (C / "storage-sdk-regressions" / "case-group.sh").read_text()
check("D2 the run used -hosts 12 (no spare)", "-indexers 3 -hosts 12" in cg)
res = (W / "claude-storage-indexd-result.md").read_text()
check("D2 prior fix: 14 hosts, 12 needed; the v060a flake was 11 of 12", "The harness runs 14 hosts and requires at least 12 contracts" in res and "`v060a`: 11 of 12 contracts" in res)
check("D2 prior u1-mode real run passed 7/7 on a U1 indexd", "| `u1b` |" in res and "**7 passed, 0 failed**" in res)
json.dump(checks, open(pathlib.Path(__file__).with_name("diagnosis-checks.json"), "w"), indent=1)
sys.exit(0 if all(c["ok"] for c in checks) else 1)
