#!/usr/bin/env bash
# check-r2.sh: the corrected checker on the EXISTING immutable release (no build, no prepare), its altered-dist controls, and
# proof the release, the built dist, the staged source and the base are byte-unchanged by the run. Output: check-r2/.
set -euo pipefail
S=$(cd "$(dirname "$0")/.." && pwd); W=/home/steven/Documents/Codex/2026-10-18/wo/work
REL=$S/release/bafybeifkfgxsjz6gnj234fvdkxa37pc4fcevydu6tb55wtidjejfsuxake; BASE=$W/logo-site-hotfix/final; O=$S/check-r2
[ -e "$O" ] && { echo "$O exists"; exit 1; }; mkdir -p "$O"
digest() { (cd "$1" && find . -path ./node_modules -prune -o -type f -print0 | sort -z | xargs -0 sha256sum | sha256sum | cut -c1-64); }
for d in "$REL" "$S/src" "$BASE/site"; do echo "$(digest "$d") $d"; done > "$O/before.txt"
rc=0; node "$S/tools/check-controls.mjs" "$REL" "$S/src" "$BASE" "$O" || rc=$?
for d in "$REL" "$S/src" "$BASE/site"; do echo "$(digest "$d") $d"; done > "$O/after.txt"
cat "$O/before.txt"
cmp -s "$O/before.txt" "$O/after.txt" && echo "INPUTS-UNCHANGED" || { echo "INPUTS-CHANGED"; diff "$O/before.txt" "$O/after.txt"; rc=1; }
echo "check-r2 rc=$rc"; exit $rc
