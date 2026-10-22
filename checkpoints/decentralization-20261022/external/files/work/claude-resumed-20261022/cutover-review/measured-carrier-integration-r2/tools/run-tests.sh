#!/usr/bin/env bash
# run-tests.sh <log prefix> (r2): ONLY the suites the r2 changes affect.
#   1. the frozen test/metal-measured-control.test.mjs on the CHANGED measured-control.mjs, now with its git baseline present
#      (tools/git-fixture.sh); all 13 must pass (r1's 12/13 was NOT a pass)
#   2. test/bundle-verifier.test.mjs: the ACTUAL generated bundle c0a68797 (and the reproduced 2a903c36 as the old negative)
set -uo pipefail; P=$(cd "$(dirname "$0")/.." && pwd); W=$(mktemp -d /tmp/measured-carrier-r2-XXXXXX); rc=0
trap 'rm -rf "$W"' EXIT
"$P/tools/make-testtree.sh" "$W/cand" "$P/inputs/candidate.host-admission.bundle.mjs" "$P/src/metal/guest/measured-control.mjs" || exit 1
"$P/tools/git-fixture.sh" "$W/cand" || exit 1
C=/home/steven/Documents/Codex/2026-10-18/wo/work/resume-20261021/reconciled-candidate/relay/fixtures/tpm-roots.pem
for b in new old; do mkdir -p "$W/run-$b/fixtures"; cp "$P/bundle/$b/platform-api.bundle.mjs" "$W/run-$b/"; cp "$C" "$W/run-$b/fixtures/tpm-roots.pem"
  python3 -c "import json,hashlib,sys;m=json.load(open('$P/bundle/$b/platform-api.bundle.mjs.manifest.json'));assert hashlib.sha256(open('$W/run-$b/fixtures/tpm-roots.pem','rb').read()).hexdigest()==m['sidecars']['fixtures/tpm-roots.pem']['sha256'];assert hashlib.sha256(open('$W/run-$b/platform-api.bundle.mjs','rb').read()).hexdigest()==m['sha256']" || exit 1; done
export NODE_OPTIONS="--preserve-symlinks --preserve-symlinks-main"
( cd "$W/cand" && node --test --test-concurrency=1 test/metal-measured-control.test.mjs ) > "$1.frozen-measured.out" 2>&1 || rc=1
cp "$P/test/bundle-verifier.test.mjs" "$W/cand/test/bundle-verifier.test.mjs"
( cd "$W/cand" && NEW_BUNDLE="$W/run-new/platform-api.bundle.mjs" OLD_BUNDLE="$W/run-old/platform-api.bundle.mjs" node --test --test-concurrency=1 test/bundle-verifier.test.mjs ) > "$1.bundle-verifier.out" 2>&1 || rc=1
for f in "$1.frozen-measured.out" "$1.bundle-verifier.out"; do echo "== $(basename "$f")"; grep -E '^# (tests|pass|fail)|^not ok' "$f"; done
echo "RC=$rc"; exit $rc
