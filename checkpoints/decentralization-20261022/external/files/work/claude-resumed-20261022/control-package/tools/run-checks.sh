#!/bin/bash
# all local, read-only over copies; writes only into this package directory
set -uo pipefail
cd "$(dirname "$0")/.."
LIVE=../../g4-control-merged-20261021/live-ref/live/control
E=$(cat ../../g4-control-merged-20261021/tools/entries.txt)
python3 tools/overlay.py > /dev/null || exit 1
python3 tools/overlays.py || exit 1
SW=$(python3 -c "import json;print(' '.join(d['name'] for d in json.load(open('manifest.json'))['deploy'] if d['group']=='control' and d['how']=='swap'))")
EM=$(for e in $E; do [ -e "minimal/$e" ] && echo $e || echo "ABSENT-LIVE-NOT-DEPLOYED $e" >&2; done)
echo "### minimal overlay (fresh-snapshot live + deploy): every entry present + manager main.mjs"; node tools/link-check.mjs minimal $EM windows/vbslike/manager/main.mjs > link-minimal.json; echo "rc=$?"
echo "### mixed (old eager + lazily importable new): agent.mjs host.mjs"; node tools/link-check.mjs mixed-agent windows/node/agent.mjs windows/node/host.mjs > link-mixed.json; echo "rc=$?"
echo "### full overlay (all 101): 60 entries + manager"; node tools/link-check.mjs overlay $E windows/vbslike/manager/main.mjs > link-full.json; echo "rc=$?"
echo "### export superset of every swapped control file"; node tools/exports.mjs $LIVE minimal $SW > exports.json; echo "rc=$?"
python3 - <<'PY'
import json
for n in ("link-minimal", "link-mixed", "link-full"):
    d = json.load(open(n + ".json")); bad = {k: v["errors"] for k, v in d.items() if not v["ok"]}
    print(n, "entries", len(d), "failing", len(bad), "agentInputs", d.get("windows/node/agent.mjs", {}).get("inputs"))
    for k, v in bad.items(): print("   ", k, "->", v[:2])
e = json.load(open("exports.json")); print("exports: files", len(e), "lost", {k: v["lost"] for k, v in e.items() if v["lost"]})
PY
