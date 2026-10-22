#!/usr/bin/env bash
set -uo pipefail
G=/home/steven/Documents/Codex/2026-10-18/wo/work/g4-control-merged-20261021; cd $G; E=$(cat tools/entries.txt)
echo "######## composed tree"; node tools/api-closure.mjs composed-tree $E > closure-composed.json; echo "rc=$?"
echo "######## frozen D1/G4 control/new over live (the package as staged)"; node tools/api-closure.mjs live-ref/frozen-over-live/control $E > closure-frozen-over-live.json; echo "rc=$?"
echo "######## live as is"; node tools/api-closure.mjs live-ref/live/control $(cd live-ref/live/control && ls windows/node/*.mjs network/*.mjs) > closure-live.json; echo "rc=$?"
python3 - <<'PY'
import json
for n in ("composed", "frozen-over-live", "live"):
    d = json.load(open(f"closure-{n}.json")); bad = {k: v["errors"] for k, v in d.items() if not v["ok"]}
    print(n, "entries", len(d), "failing", len(bad))
    for k, v in bad.items(): print("   ", k, "->", v[:3])
PY
