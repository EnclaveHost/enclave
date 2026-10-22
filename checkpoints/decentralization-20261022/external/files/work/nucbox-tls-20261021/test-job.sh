#!/usr/bin/env bash
# The manager crash fix (wmiserve-run.mjs stopRun): the whole wmiserve-run suite on the fixed tree, then a MUTATION run of
# the two new tests against the unchanged live/main file (c0154d17), which must fail. Offline; nothing touches nucbox.
set -uo pipefail
cd "$(dirname "$0")/tree/windows/vbslike/manager"
echo "== fixed tree"
node --test --test-concurrency=1 wmiserve-run.test.mjs; fixed=$?
echo "FIXED_RC=$fixed"
echo "== mutation: the unchanged wmiserve-run.mjs (live = main, sha256 c0154d17)"
M=$(mktemp -d /tmp/claude-1000/wmiserve-mut-XXXX); cp -r . "$M/"; cp ../../../../wmiserve-run.mjs.before "$M/wmiserve-run.mjs"
sha256sum "$M/wmiserve-run.mjs"
(cd "$M" && node --test --test-name-pattern="two stops of one run|closed its stdin" wmiserve-run.test.mjs); mut=$?
echo "MUTATION_RC=$mut (must be non-zero)"
rm -rf "$M"
[ $fixed -eq 0 ] && [ $mut -ne 0 ] && echo MANAGER-CRASH-FIX-TEST-OK
