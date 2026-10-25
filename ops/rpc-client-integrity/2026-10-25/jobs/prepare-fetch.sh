#!/bin/bash
# STEP 1 (root, network, no compile): pristine 5476069f tree + patch, a verification-disabled control copy, and a
# PRIVATE CARGO_HOME seeded by copying (never linking/writing) ~/.cargo/{registry,git}, then `cargo fetch --locked`.
# Run: python3 work/claude-test-queue.py --mib 1024 --log $W/logs/prepare-fetch.guard -- bash $W/jobs/prepare-fetch.sh
set -euo pipefail
. "$(dirname "$0")/env.sh"
[ ! -e "$BUILD" ] || { echo "$BUILD exists: remove it (owned by this stage) or reuse step 2"; exit 1; }
mkdir -p "$BUILD/src" "$BUILD/src-control" "$CARGO_HOME"
[ "$(git -C "$BASE_REPO" rev-parse HEAD)" = "$BASE_REV" ]
for d in src src-control; do git -C "$BASE_REPO" archive "$BASE_REV" | tar -x -C "$BUILD/$d"; done
(cd "$BUILD/src" && git apply --check "$PATCH" && git apply "$PATCH")
(cd "$BUILD/src-control" && git apply "$PATCH")
# negative control: identical code and tests, but the two new root checks are disabled -> those tests MUST fail
python3 - "$BUILD/src-control/crates/consensus/providers/src/chain_provider.rs" <<'PY'
import sys; p = sys.argv[1]; s = open(p).read()
a = "        if !self.trust_rpc {\n            // the header is fetched by"
b = "        if !self.trust_rpc {\n            // batcher transactions"
assert s.count(a) == 1 and s.count(b) == 1
s = s.replace(a, "        if false && !self.trust_rpc {\n            // the header is fetched by").replace(b, "        if false && !self.trust_rpc {\n            // batcher transactions")
open(p, "w").write(s)
PY
cp -r --reflink=auto ~/.cargo/registry ~/.cargo/git "$CARGO_HOME/" 2>/dev/null || true
(cd "$BUILD/src" && cargo fetch --locked)
sha256sum "$PATCH" "$BUILD/src/crates/consensus/providers/src/chain_provider.rs" "$BUILD/src/crates/consensus/cli/src/l1.rs" \
  "$BUILD/src-control/crates/consensus/providers/src/chain_provider.rs"
echo PREPARED
