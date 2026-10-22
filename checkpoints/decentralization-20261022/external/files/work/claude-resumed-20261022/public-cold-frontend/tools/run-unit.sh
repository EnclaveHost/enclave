#!/usr/bin/env bash
# run-unit.sh <tag> [src|ref]: the media unit test in a fresh real-copy tree (ref = unpatched negative control)
set -uo pipefail; P=$(cd "$(dirname "$0")/.." && pwd); T="$P/tree-$1"
bash "$P/tools/make-tree.sh" "$T" "${2:-src}" || exit 2
cd "$T" && node --test --test-timeout=60000 test/media-fallback.test.mjs; rc=$?; cd "$P"; rm -rf "$T"; echo "UNIT rc=$rc"; exit $rc
