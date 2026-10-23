#!/bin/bash
# Export twice (INVENTORY must be byte-identical), verify every tree offline, then a read-only secret pre-scan of the
# export with the checkpoint's own scanners/config (nothing is copied into the checkpoint by this job).
set -euo pipefail
cd "$(dirname "$0")"
CKR=/home/steven/Documents/Codex/2026-10-18/wo/work/source-checkpoint-20261022/main-repo
date -u +%FT%TZ
python3 -I export-frozen-2246.py
first=$(sha256sum frozen-2246-export/INVENTORY.json | cut -d' ' -f1)
python3 -I export-frozen-2246.py
[ "$(sha256sum frozen-2246-export/INVENTORY.json | cut -d' ' -f1)" = "$first" ] || { echo 'INVENTORY changed between exports'; exit 4; }
echo "INVENTORY byte-identical across two exports: $first"
python3 -I verify-frozen-2246-export.py
cfg=$(mktemp); git -C "$CKR" show HEAD:.gitleaks.toml > "$cfg"
set +e
timeout -k 5 300 /home/steven/.local/bin/gitleaks dir frozen-2246-export --config "$cfg" --no-banner --redact --exit-code 1 \
  --report-format json --report-path frozen-2246-prescan-gitleaks.json; g=$?
rm -f "$cfg"
echo "[prescan] gitleaks-dir=$g"
# also pre-scan every frozen source and root evidence file (copied, resolved, into a throwaway directory) with the same config
stage=$(mktemp -d)
python3 -I - "$stage" <<'PY'
import json, pathlib, shutil, sys
base = pathlib.Path('..').resolve(); inv = json.load(open('frozen-2246-export/INVENTORY.json')); st = pathlib.Path(sys.argv[1])
for g in ('frozenSources', 'rootEvidence'):
    for n in inv[g]:
        t = st / g / n.replace('../', 'UP/'); t.parent.mkdir(parents=True, exist_ok=True); shutil.copyfile((base / n).resolve(), t)
# this batch's own tool files are captured too (frozen-2246 checkpoint-scan rc 1 found a hit in one): pre-scan them as well
for n in ('export-frozen-2246.py', 'verify-frozen-2246-export.py', 'capture-frozen-2246.py', 'frozen-2246-q.sh', 'frozen-2246-export.sh',
          'frozen-2246-capture.sh', 'frozen-2246-labels.json', 'make-frozen-2246-snapshots.py'):
    t = st / 'tools' / n; t.parent.mkdir(parents=True, exist_ok=True); shutil.copyfile(n, t)
print('staged', sum(len(inv[g]) for g in ('frozenSources', 'rootEvidence')))
PY
cfg=$(mktemp); git -C "$CKR" show HEAD:.gitleaks.toml > "$cfg"
timeout -k 5 300 /home/steven/.local/bin/gitleaks dir "$stage" --config "$cfg" --no-banner --redact --exit-code 1 \
  --report-format json --report-path frozen-2246-prescan-frozen-gitleaks.json; f=$?
rm -f "$cfg"
echo "[prescan] gitleaks-frozen=$f"
# the pre-commit hook's own key scanner over the same bytes (frozen-1517-capture-1 was refused by it after gitleaks passed)
python3 -I - "$stage" <<'PY'
import json, pathlib, shutil, sys
base = pathlib.Path('..').resolve(); inv = json.load(open('frozen-2246-export/INVENTORY.json')); st = pathlib.Path(sys.argv[1])
for g in ('frozenSources', 'rootEvidence'):
    for n in inv[g]:
        t = st / g / n.replace('../', 'UP/'); t.parent.mkdir(parents=True, exist_ok=True); shutil.copyfile((base / n).resolve(), t)
# this batch's own tool files are captured too (frozen-2246 checkpoint-scan rc 1 found a hit in one): pre-scan them as well
for n in ('export-frozen-2246.py', 'verify-frozen-2246-export.py', 'capture-frozen-2246.py', 'frozen-2246-q.sh', 'frozen-2246-export.sh',
          'frozen-2246-capture.sh', 'frozen-2246-labels.json', 'make-frozen-2246-snapshots.py'):
    t = st / 'tools' / n; t.parent.mkdir(parents=True, exist_ok=True); shutil.copyfile(n, t)
PY
find frozen-2246-export "$stage" -type f -print0 | xargs -0 timeout -k 5 300 python3 "$CKR/.githooks/scan-crypto-keys.py" --files; k=$?
echo "[prescan] scan-crypto-keys-files=$k"
[ $k -eq 0 ] || g=$k
[ $f -eq 0 ] || g=$f
rm -rf "$stage"
date -u +%FT%TZ
exit $g
