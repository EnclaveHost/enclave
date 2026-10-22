#!/usr/bin/env bash
# run-browser.sh <tag> <src|ref> <alt-ok|all-down|recover>: one fresh Chromium page over a real-copy tree (patched src, or ref = unpatched control)
set -uo pipefail; P=$(cd "$(dirname "$0")/.." && pwd); T="$P/tree-$1"
bash "$P/tools/make-tree.sh" "$T" "$2" >/dev/null || exit 2
node "$P/tools/browser-media.mjs" "$T" "$3" "$P/logs/$1.json"; rc=$?; rm -rf "$T"; echo "BROWSER rc=$rc"; exit $rc
