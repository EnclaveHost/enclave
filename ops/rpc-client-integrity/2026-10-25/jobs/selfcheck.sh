#!/bin/bash
# Small offline self-check (no cargo, no deps): patch applies to pristine 5476069f, control edit hits exactly the two
# verification branches, and rustfmt (toolchain 1.96.0) PARSES both patched files (syntax only, not types).
set -uo pipefail
. "$(dirname "$0")/env.sh"
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
git -C "$BASE_REPO" archive "$BASE_REV" crates/consensus/providers/src/chain_provider.rs crates/consensus/cli/src/l1.rs rustfmt.toml | tar -x -C "$T"
cd "$T" && git apply --check "$PATCH" && git apply "$PATCH" && echo "patch applies to pristine $BASE_REV"
grep -c 'if !self.trust_rpc {' crates/consensus/providers/src/chain_provider.rs
grep -n 'calculate_receipt_root(&envelopes)\|calculate_transaction_root(&block.body.transactions)\|DEFAULT_L1_TRUST_RPC: bool = false' crates/consensus/providers/src/chain_provider.rs crates/consensus/cli/src/l1.rs
rc=0
for f in crates/consensus/providers/src/chain_provider.rs crates/consensus/cli/src/l1.rs; do
  err=$(rustfmt +1.96.0 --edition 2024 --emit stdout "$f" 2>&1 >/dev/null); r=$?
  if echo "$err" | grep -q '^error'; then echo "PARSE ERROR in $f: $err"; rc=1; else echo "parses: $f (rustfmt rc=$r)"; fi
done
echo "## selfcheck rc=$rc"; exit $rc
