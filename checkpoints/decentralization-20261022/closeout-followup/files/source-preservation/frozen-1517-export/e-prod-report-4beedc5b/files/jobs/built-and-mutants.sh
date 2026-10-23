#!/bin/bash
# (1) the built-site Chromium test against build-tree/site/dist (built from the same HEAD), (2) the chain.js mutants.
set -uo pipefail
W="$(cd "$(dirname "$0")/.." && pwd)"
cd "$W/repo"
export TMPDIR="$W/tmp" PATH="$HOME/.foundry/bin:$PATH"
echo "tests HEAD $(git rev-parse HEAD)  dist built from $(git -C "$W/build-tree" rev-parse HEAD)"
test "$(git rev-parse HEAD)" = "$(git -C "$W/build-tree" rev-parse HEAD)" || { echo "HEAD mismatch"; exit 2; }
echo "dist manifest now: $( (cd "$W/build-tree/site/dist" && find . -type f | LC_ALL=C sort | xargs sha256sum) | sha256sum | cut -d' ' -f1)"
rc=0
BUILT_SITE_DIR="$W/build-tree/site/dist" timeout -k 10 600 node --test --test-force-exit test/site-built-wallet-route.test.mjs || rc=1
echo "built-site test rc=$rc"
python3 -u "$W/jobs/mutants.py" || rc=1
echo "job rc=$rc"; exit $rc
