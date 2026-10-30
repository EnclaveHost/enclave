#!/usr/bin/env bash
# SEPARATE, NOT APPROVED by this preparation: one native dev build of the Helios CLI with the CANDIDATE build-binaries.sh.
# Only after recipe-tests rc 0 and root approval. ROOT-LAUNCHED, FOREGROUND, from work/rpc-production-final-20261025:
#   ./jobs/q-exit-status.sh canonical-build-recipe-native-N 2560 unshare -rn bash canonical-build-recipe-stage/jobs/native-cli-dev-build.sh <tests-run-dir>
# The digest is EXPECTED to differ from the accepted 8250f08a (this script remaps paths; 8250f08a was built unremapped at
# absolute stage paths): a mismatch is not a failure and a match is not claimed in advance. Its output is not accepted by
# the runtime unless separately pinned and tested.
set -uo pipefail
W=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025; BR=$W/canonical-build-recipe-stage; T=${1:?tests run dir}
B=/home/steven/Documents/Codex/2026-10-18/wo/work/resume-after-checkpoint-20261022; F=$B/rpc-runtime-final-integration/closure
grep -q '^## rc=0 ' $W/logs/$(basename "$(grep -l "fresh $T" $W/logs/*.out 2>/dev/null | head -1)") 2>/dev/null || { echo "RESULT: needs the ended recipe-tests receipt for $T"; exit 9; }
unset SOURCE_DATE_EPOCH RUSTFLAGS CARGO_TARGET_DIR; ip link set lo up 2>/dev/null || true
X=$BR/run/native-$(date -u +%Y%m%dT%H%M%SZ); [ ! -e $X ] || exit 9; mkdir -p $X; cp -a $T/cargo-home-helios $X/cargo-home-helios
bash $T/cand/scripts/rpc-runtime/build-binaries.sh $X/work $B/witness-failover/helios $B/rpc-gossip-bridge/listener $F/src/base-5476069f.tar.gz $X/cargo-home-helios dev helios; rc=$?
[ $rc = 0 ] || { echo "RESULT: NATIVE-BUILD-FAILED rc $rc"; exit 20; }
A=$(sha256sum < $X/work/target-helios-cli/debug/helios | cut -c1-64)
echo "## rc=0 (native candidate-recipe Helios CLI $A; accepted 8250f08a; equal: $([ $A = 8250f08a7b0e1f2432ea6262903ca3203b60bca6a8e17abd6d9bccbe0dbfa378 ] && echo yes || echo 'no (expected: remapped paths)'); NOT pinned, NOT deployed)"
