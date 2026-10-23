#!/bin/bash
# Export twice (INVENTORY must be byte-identical), verify every tree offline, then a read-only secret pre-scan of the
# export with the checkpoint's own scanners/config (nothing is copied into the checkpoint by this job).
set -euo pipefail
cd "$(dirname "$0")"
CKR=/home/steven/Documents/Codex/2026-10-18/wo/work/source-checkpoint-20261022/main-repo
date -u +%FT%TZ
python3 -I export-frozen-0931.py
first=$(sha256sum frozen-0931-export/INVENTORY.json | cut -d' ' -f1)
python3 -I export-frozen-0931.py
[ "$(sha256sum frozen-0931-export/INVENTORY.json | cut -d' ' -f1)" = "$first" ] || { echo 'INVENTORY changed between exports'; exit 4; }
echo "INVENTORY byte-identical across two exports: $first"
python3 -I verify-frozen-0931-export.py
cfg=$(mktemp); git -C "$CKR" show HEAD:.gitleaks.toml > "$cfg"
set +e
timeout -k 5 300 /home/steven/.local/bin/gitleaks dir frozen-0931-export --config "$cfg" --no-banner --redact --exit-code 1 \
  --report-format json --report-path frozen-0931-prescan-gitleaks.json; g=$?
rm -f "$cfg"
echo "[prescan] gitleaks-dir=$g"
# also pre-scan every frozen source and root evidence file (copied, resolved, into a throwaway directory) with the same config
stage=$(mktemp -d)
python3 -I - "$stage" <<'PY'
import json, pathlib, shutil, sys
base = pathlib.Path('..').resolve(); inv = json.load(open('frozen-0931-export/INVENTORY.json')); st = pathlib.Path(sys.argv[1])
for g in ('frozenSources', 'rootEvidence'):
    for n in inv[g]:
        t = st / g / n.replace('../', 'UP/'); t.parent.mkdir(parents=True, exist_ok=True); shutil.copyfile((base / n).resolve(), t)
print('staged', sum(len(inv[g]) for g in ('frozenSources', 'rootEvidence')))
PY
cfg=$(mktemp); git -C "$CKR" show HEAD:.gitleaks.toml > "$cfg"
timeout -k 5 300 /home/steven/.local/bin/gitleaks dir "$stage" --config "$cfg" --no-banner --redact --exit-code 1 \
  --report-format json --report-path frozen-0931-prescan-frozen-gitleaks.json; f=$?
rm -rf "$stage" "$cfg"
echo "[prescan] gitleaks-frozen=$f"
[ $f -eq 0 ] || g=$f
date -u +%FT%TZ
exit $g
