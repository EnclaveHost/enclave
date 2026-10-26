#!/usr/bin/env bash
# Source-preparation tests of the canonical Helios build recipe (candidate scripts/rpc-runtime/*) on 77d6cc859 lineage.
# ROOT-LAUNCHED, FOREGROUND, from work/rpc-production-final-20261025:
#   ./jobs/q-exit-status.sh canonical-build-recipe-tests-N 1024 unshare -rn bash canonical-build-recipe-stage/jobs/recipe-tests.sh
# T: stub-cargo plumbing tests (NOT native validation). R: the REAL `build-binaries.sh check` (real cargo metadata,
# --locked --offline, compiles nothing) on private COPIES of the closure cargo homes, candidate AND 77d6cc859 control.
# Writes only a fresh run/tests-<UTC>/. Repos, tarball, cargo homes, integration/build stages are only read. Accept only `## rc=0`.
set -uo pipefail
W=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025; BR=$W/canonical-build-recipe-stage
SRC=$W/attested-verifier-source; C=77d6cc859fbd3dba0fcf28d372e8fe463e5a589c; IA=$W/canonical-integration-actual
B=/home/steven/Documents/Codex/2026-10-18/wo/work/resume-after-checkpoint-20261022; F=$B/rpc-runtime-final-integration/closure
HREPO=$B/witness-failover/helios LREPO=$B/rpc-gossip-bridge/listener TARBALL=$F/src/base-5476069f.tar.gz
need() { local w=$1; shift; if "$@"; then echo "[ok] $w"; else echo "[FAIL] $w"; echo "RESULT: PRECHECK-FAILED (nothing tested)"; exit 9; fi; }
treehash() { (cd "$1" && find . -type f -print0 | LC_ALL=C sort -z | xargs -0 sha256sum) | sha256sum | cut -c1-64; }
unset SOURCE_DATE_EPOCH CARGO_TARGET_DIR RUSTFLAGS
ip link set lo up 2>/dev/null || true
need "offline (lo only, no route)" bash -c '[ "$(tail -n +3 /proc/self/net/dev | cut -d: -f1 | tr -d " " | sort | tr "\n" " ")" = "lo " ] && [ -z "$(tail -n +2 /proc/self/net/route)" ]'
need "stage files == SHA256SUMS" bash -c "cd $BR && sha256sum -c --quiet SHA256SUMS"
need "recorded inputs unchanged" bash -c "cd $W && grep -v '^#' $BR/jobs/INPUT-PINS.sha256 | sha256sum -c --quiet"
need "candidate 'before' blobs at $C and 'after' files as recorded" bash -c "while read b a f; do { [ \$b = NEW ] && ! git -C $SRC cat-file -e $C:\$f 2>/dev/null || [ \"\$(git -C $SRC show $C:\$f | sha256sum | cut -c1-64)\" = \$b ]; } && [ \"\$(sha256sum < $BR/candidate/\$f | cut -c1-64)\" = \$a ] || exit 1; done < $BR/SOURCE-FILES.sha256"
need "vendored patch + manifest are byte copies of the tested ones" bash -c "cmp $BR/candidate/scripts/rpc-runtime/canonical-block.patch $W/verifier-canonical-stage/canonical-block.patch && cmp $BR/candidate/scripts/rpc-runtime/canonical-block.PATCHED.sha256 $W/verifier-canonical-stage/PATCHED.sha256"
need "runtime pin/behaviour files == the integration-tested candidate (rpc-runtime.mjs, image json, e2e comment)" bash -c "for f in network/rpc-runtime.mjs metal/chain-verifier-image.json test/chain-verifier-guest.e2e.test.mjs; do cmp $BR/candidate/\$f $IA/candidate/\$f || exit 1; done"
X=$BR/run/tests-$(date -u +%Y%m%dT%H%M%SZ); need "fresh $X" [ ! -e $X ]; mkdir -p $X/tmp $X/logs; export TEST_TMP=$X/tmp TMPDIR=$X/tmp
for t in base cand; do mkdir $X/$t; git -C $SRC archive $C | tar -x -C $X/$t; done
while read f; do mkdir -p $(dirname $X/cand/$f); cp -p $BR/candidate/$f $X/cand/$f; done < $BR/CHANGED-FILES.txt
need "candidate tree differs from $C in exactly CHANGED-FILES" bash -c "diff <(cd $X && diff -rqN base cand | sed -n 's|^Files base/\(.*\) and cand/.* differ$|\1|p' | LC_ALL=C sort) $BR/CHANGED-FILES.txt"
declare -A RC; ph() { local n=$1; shift; echo "== $n"; timeout -k 10 3600 "$@" > $X/logs/$n.out 2>&1; RC[$n]=$?; tail -5 $X/logs/$n.out; echo "## $n rc=${RC[$n]}"; }
ph T-stub-cargo-plumbing env CAND_TREE=$X/cand BASE_TREE=$X/base HREPO=$HREPO LREPO=$LREPO TARBALL=$TARBALL python3 -I $BR/tests/test-build-recipe.py
echo "== R: real closure check (real cargo metadata --locked --offline, nothing compiled) on private cargo-home copies"
for h in helios listener; do cp -a $F/cargo-home-$h $X/cargo-home-$h; need "cargo-home-$h copy == original" [ "$(treehash $X/cargo-home-$h)" = "$(treehash $F/cargo-home-$h)" ]; done
ph R1-check-candidate env LISTENER_CARGO_HOME=$X/cargo-home-listener bash $X/cand/scripts/rpc-runtime/build-binaries.sh $X/r1 $HREPO $LREPO $TARBALL $X/cargo-home-helios check
ph R2-check-77d6cc859-control env LISTENER_CARGO_HOME=$X/cargo-home-listener bash $X/base/scripts/rpc-runtime/build-binaries.sh $X/r2 $HREPO $LREPO $TARBALL $X/cargo-home-helios check
grep -q '^CLOSURE_CHECK_OK$' $X/logs/R1-check-candidate.out && grep -q '^helios-cli: resolves --locked --offline' $X/logs/R1-check-candidate.out || RC[R1-check-candidate]=R1-incomplete
(cd $X && sha256sum logs/*.out > RECEIPTS.sha256)
echo "## summary: T=${RC[T-stub-cargo-plumbing]} R1=${RC[R1-check-candidate]} R2-control=${RC[R2-check-77d6cc859-control]}"
[ "${RC[R2-check-77d6cc859-control]}" = 0 ] || echo "[note] the 77d6cc859 control check failed: compare before attributing anything to the candidate"
[ "${RC[T-stub-cargo-plumbing]}" = 0 ] && [ "${RC[R1-check-candidate]}" = 0 ] || { echo "RESULT: RECIPE-TESTS-FAILED"; exit 1; }
echo "## rc=0 (recipe source-preparation + real offline closure check passed; NOTHING compiled; no digest; not committed)"
