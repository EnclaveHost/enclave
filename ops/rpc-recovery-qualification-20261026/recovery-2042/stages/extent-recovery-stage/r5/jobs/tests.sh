#!/bin/bash
# extent-recovery-stage/r1 (PREPARED by Claude; NOT compiled or run by Claude): compile the read-only overlap tool against the LOCAL
# libext2fs headers/library and run the unprivileged fixture tests on tiny ext4 IMAGE FILES (mke2fs + debugfs on files only).
# No device, no NBD, no mount, no USB, no network.
#   bash jobs/q-exit-status.sh extent-overlap-r5 512 unshare -Urn bash extent-recovery-stage/r5/jobs/tests.sh
# PASS = compile OK (-Wall -Wextra -Werror) AND test_overlap "Ran 10 tests" OK, nothing skipped; stage sums intact; no bytecode.
set -uo pipefail
export PATH=/usr/bin:/bin:/usr/sbin
W=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025
S=$W/extent-recovery-stage/r5
R2SUMS=aa194df45e01e7456263fc0379e898923c852ffbc03597b639087286116a2e82
R1SUMS=916a2df15c909dabe7ec73eb987d02e3b47e8b51dd744c0003b686452dadf1c6
O=$S/runs/run-$(date -u +%Y%m%dT%H%M%SZ)-$$
mkdir -p $O/tmp || exit 9
die() { echo "PRETEST: $*"; exit 9; }
ip link set lo up 2>/dev/null; ip -4 route | grep -v "dev lo" | grep -q . && die "network route present: run under unshare -Urn"
(cd $S && sha256sum -c --quiet SHA256SUMS) || die "r3 != SHA256SUMS"
[ "$(sha256sum < $W/extent-recovery-stage/r1/SHA256SUMS | cut -c1-64)" = $R1SUMS ] && (cd $W/extent-recovery-stage/r1 && sha256sum -c --quiet SHA256SUMS) || die "r1 changed (must stay frozen)"
[ "$(sha256sum < $W/extent-recovery-stage/r2/SHA256SUMS | cut -c1-64)" = $R2SUMS ] && (cd $W/extent-recovery-stage/r2 && sha256sum -c --quiet SHA256SUMS) || die "r2 changed (must stay frozen)"
cmp -s $W/extent-recovery-stage/r2/src/ext4-extent-overlap.c $S/src/ext4-extent-overlap.c && cmp -s $W/extent-recovery-stage/r2/src/overlap.py $S/src/overlap.py || die "r3 C tool/wrapper must be r2's (unchanged): fixture-only stage"
for t in /usr/sbin/mke2fs /usr/sbin/debugfs; do [ -x $t ] || die "$t missing"; done
[ -f /usr/include/ext2fs/ext2fs.h ] && [ -e /usr/lib/libext2fs.so ] || die "libext2fs headers/library missing"
nobc() { [ -z "$(find $S -path $S/runs -prune -o \( -name __pycache__ -o -name '*.pyc' \) -print)" ]; }
nobc || die "bytecode in the stage"
gcc -O2 -Wall -Wextra -Werror -D_FILE_OFFSET_BITS=64 -o $O/ext4-extent-overlap $S/src/ext4-extent-overlap.c -lext2fs -lcom_err > $O/compile.txt 2>&1 \
  || { cat $O/compile.txt; echo "## compile FAIL"; echo "## extent-overlap-r5 rc=1"; exit 1; }
echo "## compile OK"; sha256sum $O/ext4-extent-overlap | tee $O/binary.sha256
gcc --version | head -1 > $O/toolchain.txt; ls -l /usr/lib/libext2fs.so* >> $O/toolchain.txt
rc=0; n=test_overlap; want=10
(cd $O && env -i PATH=$PATH OVERLAP_BIN=$O/ext4-extent-overlap TEST_TMP=$O/tmp timeout -k 5 600 python3 -I -B $S/tests/$n.py) > $O/$n.txt 2>&1; r=$?
tail -3 $O/$n.txt
if grep -q "^Ran $want tests" $O/$n.txt && tail -1 $O/$n.txt | grep -qx OK && ! grep -q skipped $O/$n.txt && [ $r = 0 ]; then echo "## $n PASS ($want)"; else echo "## $n FAIL (rc $r)"; rc=1; fi
(cd $S && sha256sum -c --quiet SHA256SUMS) || { echo "## stage changed during the run"; rc=1; }
nobc || { echo "## bytecode written during the run"; rc=1; }
rm -rf $O/tmp; echo "## extent-overlap-r5 rc=$rc (binary kept: $O/ext4-extent-overlap)"; exit $rc
