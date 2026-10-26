#!/bin/bash
# mdbx-recovery-validator-stage/r1 ROOT job (PREPARED by Claude; NOT run by Claude). Builds the OFFICIAL libmdbx v0.13.12 (f619d43d)
# mdbx_chk - the libmdbx embedded in the production base v1.5.1 binary (reth 7134be3) - from the PINNED vendored dist with the
# official GNUmakefile recipe plus reth's mdbx-sys build.rs defines, then runs the fixture tests through REAL read-only bind
# mounts. No network (sources are local and pinned), no sudo, no device, no production DB, no USB.
#   bash jobs/q-exit-status.sh mdbx-validator-r2 2048 unshare -Urnm bash mdbx-recovery-validator-stage/r2/jobs/build-and-test.sh
# (2048 MiB: compiling the 1.5 MB amalgamated mdbx.c; the queue's 16 GiB host floor applies.)
# PASS = "## build OK", "## version OK v0.13.12-0-gf619d43d", "## test_mdbx_validator PASS (18)", rc=0. The built binaries and
# their sha256 are kept in runs/<run>/build for the reviewed production use (README.md).
set -uo pipefail
export PATH=/usr/bin:/bin
W=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025
S=$W/mdbx-recovery-validator-stage/r2
R1SUMS=f023beac65b409b7a2889dc5823277779bcf786e94e63f70a9aaab2714554282
SRC=$W/derivation-client-stage/combined-r1/build/deps-43698236e9186750/cargo/git/checkouts/reth-babcd6134566c621/7134be3/crates/storage/libmdbx-rs/mdbx-sys/libmdbx
O=$S/runs/run-$(date -u +%Y%m%dT%H%M%SZ)-$$
mkdir -p $O/tmp || exit 9
die() { echo "PRETEST: $*"; exit 9; }
ip link set lo up 2>/dev/null; ip -4 route | grep -v "dev lo" | grep -q . && die "network route present: run under unshare -Urnm"
(cd $S && sha256sum -c --quiet SHA256SUMS) || die "r2 != SHA256SUMS"
[ "$(sha256sum < $W/mdbx-recovery-validator-stage/r1/SHA256SUMS | cut -c1-64)" = $R1SUMS ] && (cd $W/mdbx-recovery-validator-stage/r1 && sha256sum -c --quiet SHA256SUMS) || die "r1 changed (must stay frozen)"
cmp -s $W/mdbx-recovery-validator-stage/r1/pins/libmdbx-v0.13.12-f619d43d.sha256 $S/pins/libmdbx-v0.13.12-f619d43d.sha256 && cmp -s $W/mdbx-recovery-validator-stage/r1/src/mk_fixture.c $S/src/mk_fixture.c || die "r2 pins/fixture must be r1's"
[ -d $SRC ] && [ ! -L $SRC ] || die "pinned libmdbx dist missing"
for t in /usr/bin/setsid /usr/bin/sleep /usr/bin/echo /usr/bin/true /usr/bin/mount /usr/bin/umount; do [ -x $t ] || die "$t missing"; done
(cd $SRC && sha256sum -c --quiet $S/pins/libmdbx-v0.13.12-f619d43d.sha256) || die "libmdbx dist differs from the pinned v0.13.12 files"
[ "$(cd $SRC && find . -type f | wc -l)" = "$(wc -l < $S/pins/libmdbx-v0.13.12-f619d43d.sha256)" ] || die "unpinned files in the libmdbx dist"
grep -q '"git_describe": "v0.13.12-0-gf619d43d"' $SRC/VERSION.json || die "VERSION.json is not v0.13.12-0-gf619d43d"
B=$O/build; mkdir -p $B && cp -a $SRC/. $B/ || die "copy"          # never build in (or write to) the pinned checkout
(cd $B && sha256sum -c --quiet $S/pins/libmdbx-v0.13.12-f619d43d.sha256) || die "the build copy differs from the pins"
# official recipe (GNUmakefile mdbx_% rule) + reth 7134be3 mdbx-sys build.rs defines (MDBX_TXN_CHECKOWNER=0, MDBX_USE_FALLOCATE=0,
# release: MDBX_DEBUG=0, NDEBUG). -j1, bounded.
OPTS='-DNDEBUG=1 -DMDBX_DEBUG=0 -DMDBX_TXN_CHECKOWNER=0 -DMDBX_USE_FALLOCATE=0'
(cd $B && make -j1 MDBX_BUILD_OPTIONS="$OPTS" mdbx_chk mdbx_stat mdbx_dump > $O/make.txt 2>&1) || { tail -40 $O/make.txt; echo "## build FAIL"; exit 1; }
(cd $B && cc -std=gnu11 -O2 -Wall -Wextra -Werror -pthread -I. -o mk_fixture $S/src/mk_fixture.c mdbx-static.o >> $O/make.txt 2>&1) || { tail -20 $O/make.txt; echo "## fixture build FAIL"; exit 1; }
echo "## build OK"; (cd $B && sha256sum mdbx_chk mdbx_stat mdbx_dump mk_fixture mdbx-static.o config-gnumake.h) | tee $O/binaries.sha256
cc --version | head -1 > $O/toolchain.txt; ldd $B/mdbx_chk >> $O/toolchain.txt 2>&1
$B/mdbx_chk -V > $O/version.txt 2>&1; grep -q "v0.13.12-0-gf619d43d" $O/version.txt && echo "## version OK v0.13.12-0-gf619d43d" || { cat $O/version.txt; echo "## version FAIL"; exit 1; }
CHKSHA=$(sha256sum < $B/mdbx_chk | cut -c1-64)
rc=0; n=test_mdbx_validator; want=18
(cd $O && env -i PATH=$PATH MDBX_BIN=$B MDBX_CHK_SHA256=$CHKSHA TEST_TMP=$O/tmp timeout -k 5 900 python3 -I -B $S/tests/$n.py) > $O/$n.txt 2>&1; r=$?
tail -3 $O/$n.txt
if grep -q "^Ran $want tests" $O/$n.txt && tail -1 $O/$n.txt | grep -qx OK && ! grep -q skipped $O/$n.txt && [ $r = 0 ]; then echo "## $n PASS ($want)"; else echo "## $n FAIL (rc $r)"; rc=1; fi
(cd $S && sha256sum -c --quiet SHA256SUMS) || { echo "## stage changed during the run"; rc=1; }
(cd $SRC && sha256sum -c --quiet $S/pins/libmdbx-v0.13.12-f619d43d.sha256) || { echo "## pinned dist changed during the run"; rc=1; }
[ -z "$(find $S -path $S/runs -prune -o \( -name __pycache__ -o -name '*.pyc' \) -print)" ] || { echo "## bytecode in the stage"; rc=1; }
rm -rf $O/tmp; echo "## mdbx-validator-r2 rc=$rc (mdbx_chk sha256 $CHKSHA kept in $B)"; exit $rc
