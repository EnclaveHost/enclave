#!/bin/bash
# Secret + rewritten-literal scans (checkpoint's own unchanged scanners/config) of every file to be committed: the outer
# evidence files and the restore commit's changed files. Staged binaries and node_modules are excluded (never committed).
set -uo pipefail
cd "$(dirname "$0")"
CKR=/home/steven/Documents/Codex/2026-10-18/wo/work/source-checkpoint-20261022/main-repo
st=$(mktemp -d)
for f in RESULT.md ACTIVATION-PLAN.md build-1.sh repro-1.sh control-old-gsup.sh measured-control-both.sh entries.py q.sh scan.sh logs/*.out logs/*.log stage/INVENTORY.sha256 stage/entries-vs-production.jsonl stage/release-delta.txt stage/release-delta.expected; do [ -f "$f" ] && { mkdir -p "$st/$(dirname $f)"; cp "$f" "$st/$f"; }; done
for f in $(git -C repo diff --name-only deabf8f90f64902d20d48620fd911d34c445859d HEAD); do mkdir -p "$st/repo/$(dirname $f)"; git -C repo show HEAD:$f > "$st/repo/$f"; done
cfg=$(mktemp); git -C "$CKR" show HEAD:.gitleaks.toml > "$cfg"
timeout -k 5 120 /home/steven/.local/bin/gitleaks dir "$st" --config "$cfg" --no-banner --redact --exit-code 1 --report-format json --report-path logs/scan-gitleaks.json; g=$?; rm -f "$cfg"
find "$st" -type f -print0 | xargs -0 timeout -k 5 120 python3 "$CKR/.githooks/scan-crypto-keys.py" --files; k=$?
python3 - "$st" <<'PY'; l=$?
import pathlib, sys
OLD = bytes.fromhex('54696e666f696c'); bad = [str(p) for p in pathlib.Path(sys.argv[1]).rglob('*') if p.is_file() and (OLD in p.read_bytes() or OLD.lower() in p.read_bytes())]
print('literal files', bad); sys.exit(1 if bad else 0)
PY
echo "[scan] files $(find "$st" -type f | wc -l) gitleaks=$g scan-crypto-keys=$k literal=$l"; rm -rf "$st"
[ $g -eq 0 ] && [ $k -eq 0 ] && [ $l -eq 0 ]
