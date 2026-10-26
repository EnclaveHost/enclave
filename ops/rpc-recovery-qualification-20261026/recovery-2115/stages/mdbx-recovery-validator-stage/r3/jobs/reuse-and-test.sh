#!/bin/bash
# mdbx-recovery-validator-stage/r3 ROOT job (PREPARED by Claude; NOT run by Claude). NO recompilation of libmdbx: REUSES root's
# official build 1670 (r1 job, pinned libmdbx v0.13.12 f619d43d dist) by exact sha256 - mdbx_chk c228b462..., mdbx-static.o
# 14446d9c... - copies them into this run, compiles ONLY the small fixture builder src/mk_fixture.c (root's 1676 sync fix, byte-for-byte)
# against the copied object, and runs the fixture + runner + cancellation tests through REAL read-only bind mounts.
# No network, no sudo, no device, no production DB, no USB; nothing is written to r1/r2 or the reused build directory.
#   bash jobs/q-exit-status.sh mdbx-validator-r3 512 unshare -Urnm bash mdbx-recovery-validator-stage/r3/jobs/reuse-and-test.sh
# (512 MiB: a supported queue cap; root's full official compile 1670 peaked at 403 MiB, the fixture-only run 1676 at 28 MiB.)
# PASS = "## reuse OK", "## fixture build OK", "## version OK v0.13.12-0-gf619d43d", "## test_mdbx_validator PASS (20)",
# "## no ResourceWarning", "## mdbx-validator-r3 rc=0".
set -uo pipefail
export PATH=/usr/bin:/bin
W=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025
S=$W/mdbx-recovery-validator-stage/r3
R1SUMS=f023beac65b409b7a2889dc5823277779bcf786e94e63f70a9aaab2714554282
R2SUMS=9ed80aaadd21d304937a3cbd05bf761ee63229ff8c960263b2e9f06a9e4a2329
REUSE=$W/mdbx-recovery-validator-stage/r1/runs/run-20261026T205843Z-2342321/build     # root's actual official build (1670)
CHK_PIN=c228b462c3c71c87b0fd2e9cfa6b3e6bccb2d793dd545bc6a18bef7113187981
OBJ_PIN=14446d9cec01e18660d88ea13ac26681ab800e629f88ca1ff12d9d293c99bb6f
CFG_PIN=9767ebe17e68a2528c529f859ce333eb0de47b7bf0acf521e5b303de00fb23b1    # config-gnumake.h of that build (flags, compiler)
TAG_PIN=caf1a31a72a7b18c1dc2133a1a9785b694ec22d37ee12e5d04ed71e76402f50f    # @buildflags.tag of that build
FIX_PIN=b7119d1abbdeb232b771ce2346d05c4b39d743094ad122e53596b407c8b31231    # root's 1676 mk_fixture.c (= src/mk_fixture.c)
O=$S/runs/run-$(date -u +%Y%m%dT%H%M%SZ)-$$
mkdir -p $O/tmp || exit 9
die() { echo "PRETEST: $*"; exit 9; }
sha() { sha256sum < "$1" | cut -c1-64; }
ip link set lo up 2>/dev/null; ip -4 route | grep -v "dev lo" | grep -q . && die "network route present: run under unshare -Urnm"
(cd $S && sha256sum -c --quiet SHA256SUMS) || die "r3 != SHA256SUMS"
[ "$(sha $W/mdbx-recovery-validator-stage/r1/SHA256SUMS)" = $R1SUMS ] && (cd $W/mdbx-recovery-validator-stage/r1 && sha256sum -c --quiet SHA256SUMS) || die "r1 changed (must stay frozen)"
[ "$(sha $W/mdbx-recovery-validator-stage/r2/SHA256SUMS)" = $R2SUMS ] && (cd $W/mdbx-recovery-validator-stage/r2 && sha256sum -c --quiet SHA256SUMS) || die "r2 changed (must stay frozen)"
cmp -s $W/mdbx-recovery-validator-stage/r1/pins/libmdbx-v0.13.12-f619d43d.sha256 $S/pins/libmdbx-v0.13.12-f619d43d.sha256 || die "r3 pins must be r1's"
[ "$(sha $S/src/mk_fixture.c)" = $FIX_PIN ] || die "src/mk_fixture.c is not root's 1676 fixture fix"
for t in /usr/bin/setsid /usr/bin/sleep /usr/bin/echo /usr/bin/true /usr/bin/mount /usr/bin/umount /usr/bin/cc; do [ -x $t ] || die "$t missing"; done
[ -d $REUSE ] && [ ! -L $REUSE ] || die "reused build dir missing or a symlink"
for f in mdbx_chk mdbx-static.o mdbx.h config-gnumake.h @buildflags.tag; do [ -f "$REUSE/$f" ] && [ ! -L "$REUSE/$f" ] || die "$REUSE/$f missing or a symlink"; done
[ "$(sha $REUSE/mdbx_chk)" = $CHK_PIN ] || die "reused mdbx_chk != $CHK_PIN"
[ "$(sha $REUSE/mdbx-static.o)" = $OBJ_PIN ] || die "reused mdbx-static.o != $OBJ_PIN"
[ "$(sha $REUSE/config-gnumake.h)" = $CFG_PIN ] && [ "$(sha $REUSE/@buildflags.tag)" = $TAG_PIN ] || die "reused build flags differ"
(cd $REUSE && sha256sum -c --quiet $S/pins/libmdbx-v0.13.12-f619d43d.sha256) || die "the reused build's source copy differs from the pinned v0.13.12 dist"
grep -q '"git_describe": "v0.13.12-0-gf619d43d"' $REUSE/VERSION.json || die "VERSION.json is not v0.13.12-0-gf619d43d"
B=$O/bin; mkdir -p $B && cp $REUSE/mdbx_chk $REUSE/mdbx-static.o $REUSE/mdbx.h $B/ || die "copy"     # never write into $REUSE
[ "$(sha $B/mdbx_chk)" = $CHK_PIN ] && [ "$(sha $B/mdbx-static.o)" = $OBJ_PIN ] || die "the copies differ"
echo "## reuse OK (mdbx_chk $CHK_PIN, mdbx-static.o $OBJ_PIN; no libmdbx recompilation)"
(cd $B && cc -std=gnu11 -O2 -Wall -Wextra -Werror -pthread -I. -o mk_fixture $S/src/mk_fixture.c mdbx-static.o > $O/make.txt 2>&1) || { tail -20 $O/make.txt; echo "## fixture build FAIL"; exit 1; }
echo "## fixture build OK"; (cd $B && sha256sum mdbx_chk mdbx-static.o mk_fixture) | tee $O/binaries.sha256
cc --version | head -1 > $O/toolchain.txt; ldd $B/mdbx_chk >> $O/toolchain.txt 2>&1
$B/mdbx_chk -V > $O/version.txt 2>&1; vr=$?
[ $vr = 0 ] && grep -q "v0.13.12-0-gf619d43d" $O/version.txt && echo "## version OK v0.13.12-0-gf619d43d" || { cat $O/version.txt; echo "## version FAIL (rc $vr)"; exit 1; }
rc=0; n=test_mdbx_validator; want=20
(cd $O && env -i PATH=$PATH MDBX_BIN=$B MDBX_CHK_SHA256=$CHK_PIN TEST_TMP=$O/tmp timeout -k 5 900 python3 -I -B -W always::ResourceWarning $S/tests/$n.py) > $O/$n.txt 2>&1; r=$?
tail -3 $O/$n.txt
if grep -q "^Ran $want tests" $O/$n.txt && tail -1 $O/$n.txt | grep -qx OK && ! grep -q skipped $O/$n.txt && [ $r = 0 ]; then echo "## $n PASS ($want)"; else echo "## $n FAIL (rc $r)"; rc=1; fi
if grep -q ResourceWarning $O/$n.txt; then grep -m5 -A1 ResourceWarning $O/$n.txt; echo "## ResourceWarning present"; rc=1; else echo "## no ResourceWarning"; fi
(cd $S && sha256sum -c --quiet SHA256SUMS) || { echo "## stage changed during the run"; rc=1; }
[ "$(sha $REUSE/mdbx_chk)" = $CHK_PIN ] && [ "$(sha $REUSE/mdbx-static.o)" = $OBJ_PIN ] || { echo "## reused build changed during the run"; rc=1; }
[ -z "$(find $S -path $S/runs -prune -o \( -name __pycache__ -o -name '*.pyc' \) -print)" ] || { echo "## bytecode in the stage"; rc=1; }
rm -rf $O/tmp; echo "## mdbx-validator-r3 rc=$rc (mdbx_chk sha256 $CHK_PIN; run copies in $B)"; exit $rc
