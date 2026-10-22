#!/usr/bin/env bash
# run-tests.sh <log prefix>: builds the candidate and base test trees (tools/make-testtree.sh) in a fresh temp dir, then runs
#   1. test/measured-carriers.test.mjs (this package: bound member, env, plan, END-TO-END actual supervisor, old negative)
#   2. the frozen test/metal-measured-control.test.mjs against the CHANGED measured-control.mjs (its own regression)
set -uo pipefail; P=$(cd "$(dirname "$0")/.." && pwd); W=$(mktemp -d /tmp/measured-carrier-XXXXXX); rc=0
trap 'rm -rf "$W"' EXIT
"$P/tools/make-testtree.sh" "$W/cand" "$P/inputs/candidate.host-admission.bundle.mjs" "$P/src/metal/guest/measured-control.mjs" || exit 1
"$P/tools/make-testtree.sh" "$W/base" "$P/inputs/installed-6bef.host-admission.bundle.mjs" "$P/base/metal/guest/measured-control.mjs" || exit 1
export NODE_OPTIONS="--preserve-symlinks --preserve-symlinks-main"
( cd "$W/cand" && BASE_TREE="$W/base" node --test --test-concurrency=1 test/measured-carriers.test.mjs ) > "$1.carriers.out" 2>&1 || rc=1
( cd "$W/cand" && node --test --test-concurrency=1 test/metal-measured-control.test.mjs ) > "$1.frozen-measured.out" 2>&1 || rc=1
for f in "$1.carriers.out" "$1.frozen-measured.out"; do echo "== $(basename "$f")"; grep -E '^# (tests|pass|fail)|^not ok' "$f"; done
echo "RC=$rc"; exit $rc
