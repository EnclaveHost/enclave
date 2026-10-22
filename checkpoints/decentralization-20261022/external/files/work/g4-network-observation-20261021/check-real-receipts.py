#!/usr/bin/env python3
"""PURE local check against ROOT's actual receipts (no remote): baseline P2 232020Z + restart 232043Z + root's own post-restart
preflight 232222Z. That preflight has no hs2 probe, so the hs2 source is UNAVAILABLE by construction. This proves the observer
parses the real shapes; it is not the observer's own snapshot."""
import importlib.util, json, pathlib
H = pathlib.Path(__file__).resolve().parent; RUNS = H.parent / "g4-node-ai-final-20261021/helper/runs"
s = importlib.util.spec_from_file_location("obs", H / "root-g4-network-observe.py"); O = importlib.util.module_from_spec(s); s.loader.exec_module(O)
R, _ = O.load_pinned(); R.m.ps = lambda *a, **k: (_ for _ in ()).throw(AssertionError("no remote"))
base = json.loads((RUNS / "preflight-20261021T232020Z.json").read_text()); rr = json.loads((RUNS / "restart-agent-result-20261021T232043Z.json").read_text())
post = json.loads((RUNS / "preflight-20261021T232222Z.json").read_text())
r = O.evaluate(base, rr, O.reduce(post, {"error": "root's preflight carries no hs2 probe"}), json.loads(O.HS_AFTER[0].read_text()), R.FILES)
print(json.dumps({"status": r["status"], "elapsedSinceRestartSec": r["elapsedSinceRestartSec"], "failed": [c for c in r["checks"] if c["ok"] is False],
                  "unavailable": [c for c in r["checks"] if c["ok"] is None], "passed": sum(c["ok"] is True for c in r["checks"]), "informational": r["informational"]}, indent=1))
