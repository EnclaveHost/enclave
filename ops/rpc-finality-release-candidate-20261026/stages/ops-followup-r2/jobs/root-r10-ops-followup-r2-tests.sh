#!/bin/bash
# base-finality-proof-stage/r10-ops-followup-r2: root's LOCAL, OFFLINE qualification of the r2 (journal-aware) retention + the follow-up installer
# (PREPARED; NOT run by Claude). Supersedes r10-ops-followup's job; r10 and r10-ops-followup are frozen and only read:
#   ST=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/base-finality-proof-stage/r10-ops-followup-r2
#   python3 -u /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/../claude-test-queue.py --mib 1536 --log $ST/logs/root-r10-ops-followup-r2-tests.guard -- unshare -rn bash $ST/jobs/root-r10-ops-followup-r2-tests.sh > $ST/logs/root-r10-ops-followup-r2-tests.out 2>&1; echo $? > $ST/logs/root-r10-ops-followup-r2-tests.rc
# reproof.py, its tests and MANIFEST = r10-ops-followup + patches/r2-<path>.patch; the installer and its tests are byte copies of it (checked). Runs ONLY the suites whose code or tests changed, in a private copy
# of r10 with these files overlaid: ops-installer 18 (13 + 5) and reproof 17 (9 + 4 + 4 crash-boundary). Nothing else changes: no module pins reproof.py,
# and install_verified.py is not an installed file; the MANIFEST differs from r10's ONLY in the reproof.py sha (checked).
set -uo pipefail
export PATH=/usr/bin:/bin
ip link set lo up 2>/dev/null; ip -o addr show lo 2>/dev/null | grep -q '127.0.0.1' || { echo "## SETUP: loopback is not up"; exit 9; }
P=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025; B=$P/base-finality-proof-stage; R10=$B/r10; ST=$B/r10-ops-followup-r2; RR7=$P/base-reanchor-recovery-stage/r7
A2=$P/source/ops/rpc-backend-bootstrap/2026-10-25/a2-v2-release-bound-prepared/stage; FAKE=$B/pinned-checkpoint-parser/fixtures/fake_base.py; DEPS=$P/source
OUT=$ST/logs/root-r10-ops-followup-r2-tests-$(date -u +%Y%m%dT%H%M%SZ)-$$; rc=0
die() { echo "## SETUP: $*"; echo "## r10-ops-followup-r2 rc=9"; exit 9; }
fail() { echo "## FAIL: $*"; rc=1; }
pin() { [ "$(sha256sum < "$1" | cut -c1-64)" = "$2" ] || die "$1 is not $2"; }
tcopy() { mkdir -p "$2" && (cd "$1" && tar --exclude=./logs --exclude='__pycache__' --exclude=./bundle -cf - .) | (cd "$2" && tar -xf -) || die "copy $1"; }
[ ! -e "$OUT" ] && mkdir -p "$OUT/tmp" || die "output dir"
ip -o route 2>/dev/null | grep -q . && die "network route present: run under unshare -rn"
F1=$B/r10-ops-followup; pin $F1/SHA256SUMS 09fb4941ffaf8683d01122d1f78bf01c9f8b0a360513fcd20e57d00c563d33b5; (cd $F1 && sha256sum -c --quiet SHA256SUMS) || die "r10-ops-followup changed"
pin $R10/SHA256SUMS 1dbb3abb6a8d2e162817d13531b9369b0bceb3eef11d4395f2719b062b4a6dcb; (cd $R10 && sha256sum -c --quiet SHA256SUMS) || die "r10 changed"
(cd $ST && sha256sum -c --quiet SHA256SUMS) || die "follow-up files differ from SHA256SUMS"
pin $A2/a2a4.py abe223d6a0c6c203f7d76aaa4c68d25f8f7ecb74894e64dd838383abf6aeeadd; pin $RR7/MANIFEST.sha256 9b558d5bc723a80cd40999741e5ea11b96f357be617a24be1a7e8b929d85c6cb; pin $FAKE 73ad09a77c1c1ca48aee347eb836f280794347332277f6b32c078d8185787802
FILES="src/reproof.py install/install_verified.py install/MANIFEST.json tests/test_reproof.py tests/test_ops_installer.py"
for f in src/reproof.py tests/test_reproof.py install/MANIFEST.json; do T=$OUT/tmp/pc; rm -rf $T; mkdir -p $T && cp $F1/$f $T/x && (cd $T && patch -s x < "$ST/patches/r2-$(echo $f | tr / _).patch") && cmp -s $T/x $ST/$f || die "$f != r10-ops-followup + r2 patch"; done
for f in install/install_verified.py tests/test_ops_installer.py; do cmp -s $F1/$f $ST/$f || die "$f is not the r10-ops-followup copy"; done
/usr/bin/python3 -I - $R10 $ST <<'PYM' || die "manifest delta"
import hashlib, json, pathlib, sys
a, b = (json.loads((pathlib.Path(p) / 'install/MANIFEST.json').read_bytes()) for p in sys.argv[1:3]); new = hashlib.sha256((pathlib.Path(sys.argv[2]) / 'src/reproof.py').read_bytes()).hexdigest()
for e in a['files']:
    if e['dest'] == '/opt/enclave-rpc/finality/src/reproof.py':
        e['sha256'] = new
assert a == b, 'the manifest differs from r10 in more than the reproof.py sha'
print('manifest = r10 with reproof.py ->', new[:12])
PYM
WK=$OUT/work; tcopy $A2 $WK/source/ops/rpc-backend-bootstrap/2026-10-25/a2-v2-release-bound-prepared/stage
cp $R10/harness-first/a2a4.py $WK/source/ops/rpc-backend-bootstrap/2026-10-25/a2-v2-release-bound-prepared/stage/a2a4.py && cp $FAKE $WK/source/ops/rpc-backend-bootstrap/2026-10-25/a2-v2-release-bound-prepared/stage/test/fake_base.py || die "fixture stage"
tcopy $P/a1-capture-binding-stage/r4 $WK/a1-capture-binding-stage/r4; tcopy $RR7 $WK/base-reanchor-recovery-stage/r7
NODE=$(command -v node) && NODE=$(realpath -e "$NODE") || die "node not found"
SC=$OUT/stage; tcopy $R10 $SC; for f in $FILES; do cp $ST/$f $SC/$f || die "overlay $f"; done
check() { local name=$1 want=$2 f=$OUT/$1.txt r=$3; local ran last; ran=$(grep -oE '^Ran [0-9]+ tests? in ' $f | tail -1 | grep -oE '[0-9]+'); last=$(grep -E '^(OK|FAILED)( |$)' $f | tail -1)
  if [ "$r" = 0 ] && [ "$last" = OK ] && [ "$ran" = "$want" ] && ! grep -qE 'skipped|expected failure|unexpected success' $f; then echo "PASS $name Ran $ran (expected $want)"
  else fail "$name: rc $r, Ran ${ran:-?} (expected $want), last ${last:-none} (see $f)"; fi; }
E=(env -i PATH=/usr/bin:/bin TMPDIR=$OUT/tmp HOME=$OUT/tmp FINALITY_NODE=$NODE ANCHOR_DEPS_ROOT=$DEPS FINALITY_HARNESS=$SC/harness/a2a4.py PRODUCER_WORK=$WK CAPTURE_MODULE=$SC/capture/a1_capture.py)
for s in ops-installer:test_ops_installer.py:18:600 reproof:test_reproof.py:17:3600; do
  IFS=: read -r name file want t <<< "$s"
  (cd $SC && "${E[@]}" timeout $t /usr/bin/python3 -I -B tests/$file -v < /dev/null) > $OUT/$name.txt 2>&1; check $name $want $?; done
(cd "$ST" && sha256sum -c --quiet SHA256SUMS) || fail "follow-up files CHANGED during the run"
echo "## outputs: $OUT"; echo "## r10-ops-followup-r2 SHA256SUMS $(sha256sum < $ST/SHA256SUMS | cut -c1-64)"; echo "## r10-ops-followup-r2 rc=$rc"; exit $rc
