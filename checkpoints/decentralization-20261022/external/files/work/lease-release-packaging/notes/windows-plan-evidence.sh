#!/usr/bin/env bash
# Evidence for the Windows activation on the REAL inputs (read-only): repack root's staged closure with this candidate's
# reviewed changes, then build the activation plan from root's read-only host inventory (live-closure.json) and check it
# against root's own diff (live-changes.json): the same 32 paths, the same installed (before) hashes, and AFTER hashes
# equal to the repacked source - with host.mjs the only path whose AFTER differs from root's staged closure.
set -euo pipefail
C=$(cd "$(dirname "$0")/.." && pwd -P); W=$(cd "$C/.." && pwd -P); I="$W/windows-lease-source-integration"
python3 "$C/notes/repack-windows-source.py"
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
mkdir -p "$T/src" && tar -xf "$C/stage/windows-control-source.tar" -C "$T/src"
python3 -c "
import json,sys; c=json.load(open('$I/live-closure.json')); json.dump({'files':[{'path':f['path'],'sha256':f['sha256']} for f in c['files']]}, open('$T/closure.json','w'))"
node "$C/src/windows/installer/activate-control-source.mjs" plan --closure "$T/closure.json" --source "$T/src" --id lease-closure-2026-10-20 --out "$C/stage/activation-plan.json"
python3 - "$C/stage/activation-plan.json" "$I/live-changes.json" "$I/staged-source-manifest.json" <<'PY'
import json, sys
plan, live, base = (json.load(open(f)) for f in sys.argv[1:4])
lp = {e["path"]: e for e in live}; pp = {e["path"]: e for e in plan["files"]}; staged = {f["path"]: f["sha256"] for f in base["files"]}
assert set(pp) == set(lp), (sorted(set(pp) ^ set(lp)))
for p, e in pp.items(): assert e["before"] == lp[p]["before"], p
differ = sorted(p for p, e in pp.items() if e["after"] != lp[p]["after"])
assert differ == ["windows/node/host.mjs"], differ
assert len(plan["unchanged"]) == 48 and all(staged[u["path"]] == u["sha256"] for u in plan["unchanged"])
print(json.dumps({"planPaths": len(pp), "unchanged": len(plan["unchanged"]), "beforeHashesEqualRootInventory": True,
  "afterDiffersFromRootStagedOnly": differ, "managerShared": [p for p in pp if p.startswith(("windows/vbslike/manager/", "windows/vbslike/datapath/"))]}))
PY
