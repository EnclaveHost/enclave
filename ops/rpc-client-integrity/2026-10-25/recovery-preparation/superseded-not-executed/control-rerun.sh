#!/bin/bash
# M7 NEGATIVE-CONTROL rerun (root-launchable, OFFLINE). The pinned jobs/test-offline.sh builds src/ and src-control/ into ONE
# CARGO_TARGET_DIR. Cargo's unit hash for workspace path packages is workspace-relative, and the control file's mtime
# (git apply, 11:28:58) predated the patched test binary (11:33:16), so the r2 "control" reused the PATCHED binary
# ("Finished ... 0.58s", no Compiling line). That control result is INVALID. This job leaves the pinned jobs unchanged
# (it only sources env.sh) and gives the control its own target dir.
# Run: CARGO_BUILD_JOBS=1 python3 work/claude-test-queue.py --mib 1792 --log $WS/logs/root-control-rerun.guard \
#        -- unshare -rn bash $WS/queue-recovery/control-rerun.sh
set -uo pipefail
. /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/finality-stage/client-integrity-next/jobs/env.sh
PATCHED_TARGET=$CARGO_TARGET_DIR
export CARGO_TARGET_DIR=$BUILD/target-control
C=$BUILD/src-control/crates/consensus/providers/src/chain_provider.rs
[ "$(grep -c 'if false && !self.trust_rpc {' "$C")" = 2 ] || { echo "## control source does not disable exactly the two checks"; exit 1; }
[ -d "$CARGO_TARGET_DIR" ] || cp -a --reflink=auto "$PATCHED_TARGET" "$CARGO_TARGET_DIR"   # dependency cache only
touch "$C"                                                       # make the control source newer than any artifact
cd "$BUILD/src-control"
out=$(cargo test --offline --locked -p base-consensus-providers --lib chain_provider:: -- --test-threads=2 2>&1); r=$?
echo "$out"
rc=0
echo "$out" | grep -q 'Compiling base-consensus-providers' || { echo "## CONTROL WAS NOT REBUILT"; rc=1; }
bin=$(echo "$out" | sed -n 's/.*Running unittests src\/lib.rs (\(.*\))$/\1/p' | head -1)
case "$bin" in "$CARGO_TARGET_DIR"/*) ;; *) echo "## control ran a binary outside $CARGO_TARGET_DIR: $bin"; rc=1;; esac
pb=$(ls -t "$PATCHED_TARGET"/debug/deps/base_consensus_providers-* 2>/dev/null | grep -v '\.d$' | head -1)
[ -n "$bin" ] && [ -n "$pb" ] && [ "$(sha256sum < "$bin")" != "$(sha256sum < "$pb")" ] || { echo "## control binary equals the patched binary"; rc=1; }
fails=$(echo "$out" | sed -n 's/^    chain_provider::tests::\([a-z_]*\)$/\1/p' | sort | tr '\n' ' ')
want="altered_log_is_refused omitted_receipt_is_refused_and_not_cached reordered_receipts_are_refused transactions_must_match_the_verified_transactions_root "
echo "## control cargo rc=$r failing: $fails"
if [ "$r" = 0 ] || [ "$fails" != "$want" ]; then echo "## CONTROL DID NOT FAIL EXACTLY AS EXPECTED"; rc=1; fi
echo "## control-rerun rc=$rc (0 = the four root-check tests fail without the checks, everything else passes)"; exit $rc
