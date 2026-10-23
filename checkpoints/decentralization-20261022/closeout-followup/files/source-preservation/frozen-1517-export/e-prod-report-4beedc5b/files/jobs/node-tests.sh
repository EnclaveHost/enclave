#!/bin/bash
# node --test over the named test files of this tree (TMPDIR on disk; whole-job wall clock bound inside)
set -uo pipefail
cd "$(dirname "$0")/../repo"
export TMPDIR="$(cd .. && pwd)/tmp"
export PATH="$HOME/.foundry/bin:$PATH"
git log -1 --format='HEAD %H'; git status --short | head -40
sha256sum site/js/core/{profile-broadcast,wallet,chain}.js test/helpers/independent-browser-rig.mjs "$@"
exec timeout -k 10 "${JOB_SEC:-600}" node --test --test-force-exit --test-concurrency=1 "$@"
