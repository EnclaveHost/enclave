#!/usr/bin/env python3
"""build-harness.sh helper: both accepted snapshots must equal the A1 inventories + the accepted form_test.go, checked
with the pinned base runner's own inventory functions (root's accepted contracts_pg_runner.py ed8e0fdd)."""
import json, pathlib, sys
H = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(H)); import sdk_regression_runner as S
cfg = json.loads((H / "config.json").read_text()); B = S.load_base(cfg)
for s in cfg["snapshots"]:
    if B.tree_inventory(s["snapshot"]) != B.expected_inventory(s): sys.exit(f"snapshot {s['name']} differs from the accepted inventory")
    print(f"{s['name']}: accepted inventory")
