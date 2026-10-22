#!/usr/bin/env bash
# make-tree.sh <out> [ref|src]: REAL copies (cp -rL) of the reconciled candidate's site/js + site/components + test/helpers, with
# this package's 5 files overlaid (src) or not (ref = the unpatched negative control). Nothing is symlinked; nothing outside <out> is written.
set -euo pipefail
OUT="$1"; MODE="${2:-src}"; P=$(cd "$(dirname "$0")/.." && pwd); C=/home/steven/Documents/Codex/2026-10-18/wo/work/resume-20261021/reconciled-candidate
rm -rf "$OUT"; mkdir -p "$OUT/site" "$OUT/test"
cp -rL "$C/site/js" "$C/site/components" "$OUT/site/"; cp -rL "$C/test/helpers" "$OUT/test/"
mkdir -p "$OUT/network"; for n in host-liveness host-policy-mirrors network-policy-core canonical wg-config; do cp -L "$C/network/$n.mjs" "$OUT/network/"; done
cp -rL "$C/site/vendor" "$OUT/site/"
for f in site/js/core/config.js site/js/core/catalog.js site/components/app-card/app-card.js site/components/app-detail/app-detail.js site/components/deployments/deployments.js; do
  cp --remove-destination "$P/$MODE/$f" "$OUT/$f"; done
cp "$P"/test/*.mjs "$OUT/test/" 2>/dev/null || true
[ -z "$(find "$OUT" -type l)" ] || { echo "symlink in tree"; exit 1; }
echo "tree $OUT ($MODE) catalog $(sha256sum "$OUT/site/js/core/catalog.js" | cut -c1-8)"
