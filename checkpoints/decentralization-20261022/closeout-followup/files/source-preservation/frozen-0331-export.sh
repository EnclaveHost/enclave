#!/bin/bash
# Export twice (INVENTORY must be byte-identical), verify every tree offline, then a read-only secret pre-scan of the
# export with the checkpoint's own scanners/config (nothing is copied into the checkpoint by this job).
set -euo pipefail
cd "$(dirname "$0")"
CKR=/home/steven/Documents/Codex/2026-10-18/wo/work/source-checkpoint-20261022/main-repo
date -u +%FT%TZ
python3 -I export-frozen-0331.py
first=$(sha256sum frozen-0331-export/INVENTORY.json | cut -d' ' -f1)
python3 -I export-frozen-0331.py
[ "$(sha256sum frozen-0331-export/INVENTORY.json | cut -d' ' -f1)" = "$first" ] || { echo 'INVENTORY changed between exports'; exit 4; }
echo "INVENTORY byte-identical across two exports: $first"
python3 -I verify-frozen-0331-export.py
cfg=$(mktemp); git -C "$CKR" show HEAD:.gitleaks.toml > "$cfg"
set +e
timeout -k 5 300 /home/steven/.local/bin/gitleaks dir frozen-0331-export --config "$cfg" --no-banner --redact --exit-code 1 \
  --report-format json --report-path frozen-0331-prescan-gitleaks.json; g=$?
rm -f "$cfg"
echo "[prescan] gitleaks-dir=$g"
date -u +%FT%TZ
exit $g
