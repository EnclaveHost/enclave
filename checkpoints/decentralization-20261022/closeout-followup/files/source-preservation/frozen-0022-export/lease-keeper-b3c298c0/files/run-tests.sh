#!/bin/bash
set -u; cd "$(dirname "$0")"; rc=0
for f in *.mjs tests/*.mjs; do node --check "$f" || rc=1; done; bash -n keeper-loop.sh || rc=1
timeout -k 5 300 node --test --test-force-exit --test-concurrency=1 tests/keeper.test.mjs || rc=1
OLD=$(printf '\x54\x69\x6e\x66\x6f\x69\x6c'); grep -rIil "$OLD" --exclude-dir=.git --exclude-dir=state . && { echo "old literal"; rc=1; }
git ls-files --others --cached --exclude-standard | xargs cat | timeout -k 5 120 gitleaks stdin --no-banner --redact --exit-code 1 || rc=1
echo "== RESULT rc=$rc"; exit $rc
