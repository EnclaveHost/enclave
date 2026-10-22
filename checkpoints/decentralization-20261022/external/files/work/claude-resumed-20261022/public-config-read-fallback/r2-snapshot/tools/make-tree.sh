#!/usr/bin/env bash
# make-tree.sh <out> [src|base]: REAL copies (cp -rL) of the reconciled candidate's site/js + site/components + site/vendor +
# test/helpers (+ the network modules config.js imports), then the ACCEPTED media patch (public-cold-frontend/src, 04836638),
# then this package's files (src) or not (base = the accepted media state, the negative control). Candidate test files
# that exercise the callsites are copied too. Nothing is symlinked; nothing outside <out> is written.
set -euo pipefail
OUT="$1"; MODE="${2:-src}"; P=$(cd "$(dirname "$0")/.." && pwd); W=$(cd "$P/../.." && pwd)
C=$W/resume-20261021/reconciled-candidate; M=$W/claude-resumed-20261022/public-cold-frontend
rm -rf "$OUT"; mkdir -p "$OUT/site" "$OUT/test" "$OUT/network"
cp -rL "$C/site/js" "$C/site/components" "$C/site/vendor" "$OUT/site/"; cp -rL "$C/test/helpers" "$OUT/test/"
for n in host-liveness host-policy-mirrors network-policy-core canonical wg-config; do cp -L "$C/network/$n.mjs" "$OUT/network/"; done
for f in site/js/core/config.js site/js/core/catalog.js site/components/app-card/app-card.js site/components/app-detail/app-detail.js site/components/deployments/deployments.js; do
  cp --remove-destination "$M/src/$f" "$OUT/$f"; done
[ "$MODE" != base ] && for f in site/js/core/catalog.js site/js/core/storage-plan.js site/js/core/unixfs.js; do cp --remove-destination "$P/$MODE/$f" "$OUT/$f"; done   # src, or a mut-* control
for t in publish-prefill-config models-read-only; do cp -L "$C/test/$t.test.mjs" "$OUT/test/"; done
cp -L "$M/test/media-fallback.test.mjs" "$OUT/test/"; cp "$P"/test/*.mjs "$OUT/test/"
cp -rL "$P/oracle/node_modules" "$OUT/"          # TEST-ONLY oracle (multiformats 13.4.1); no site module imports it
[ -z "$(find "$OUT" -type l)" ] || { echo "symlink in tree"; exit 1; }
! grep -rqs "multiformats" "$OUT/site" || { echo "site imports the oracle"; exit 1; }
echo "tree $OUT ($MODE) catalog $(sha256sum "$OUT/site/js/core/catalog.js" | cut -c1-8) storage-plan $(sha256sum "$OUT/site/js/core/storage-plan.js" | cut -c1-8) unixfs $(sha256sum "$OUT/site/js/core/unixfs.js" | cut -c1-8)"
