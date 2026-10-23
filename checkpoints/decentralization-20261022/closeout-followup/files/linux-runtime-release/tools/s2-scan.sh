#!/usr/bin/env bash
# s2 (queue 256): gitleaks over exactly the publishable set (RESULT, RECIPE, PINS, public/, tools/, patches/), with the
# checkpoint repo's own gitleaks config; plus the PINS check. No network (q.sh namespace).
set -euo pipefail
. "$(dirname "$0")/env.sh"
CFG=/home/steven/Documents/Codex/2026-10-18/wo/work/source-checkpoint-20261022/main-repo/.gitleaks.toml
T=$B/tmp/scan; rm -rf "$T"; mkdir -p "$T"
cp -r "$B/RESULT-LINUX-PACKAGE.md" "$B/RECIPE.md" "$B/PINS.sha256" "$B/public" "$B/tools" "$B/patches" "$T/"
( cd "$B" && sha256sum -c --quiet PINS.sha256 ) && echo "[ok] PINS.sha256 verifies"
gitleaks dir "$T" --config "$CFG" --no-banner --redact --report-format json --report-path "$B/receipts/gitleaks-publish.json"
echo "[ok] gitleaks: no leaks ($(du -sh "$T" | cut -f1))"; rm -rf "$T"
