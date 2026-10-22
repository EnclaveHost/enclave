#!/usr/bin/env bash
# run-unit.sh <tag> [src|base] [test files...]: node --test in a fresh real-copy tree, then the tree is removed
set -uo pipefail; P=$(cd "$(dirname "$0")/.." && pwd); T="$P/tree-$1"; MODE="${2:-src}"; shift 2 || shift $#
bash "$P/tools/make-tree.sh" "$T" "$MODE" || exit 2
FILES=("$@"); [ ${#FILES[@]} -gt 0 ] || FILES=(test/car-verify-oracle.test.mjs test/config-read-fallback.test.mjs test/media-fallback.test.mjs test/models-read-only.test.mjs test/publish-prefill-config.test.mjs)
cd "$T" && node --test --test-concurrency=1 --test-timeout=90000 "${FILES[@]}"; rc=$?; cd "$P"; rm -rf "$T"; echo "UNIT rc=$rc"; exit $rc
