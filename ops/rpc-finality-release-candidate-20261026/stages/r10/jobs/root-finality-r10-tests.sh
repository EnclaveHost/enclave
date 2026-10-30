#!/bin/bash
# base-finality-proof-stage/r10: root's LOCAL, OFFLINE qualification job (PREPARED; NOT run by Claude). Through the queue:
#   ST=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/base-finality-proof-stage/r10
#   python3 -u /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/../claude-test-queue.py --mib 1536 --log $ST/logs/root-finality-r10-tests.guard -- unshare -rn bash $ST/jobs/root-finality-r10-tests.sh > $ST/logs/root-finality-r10-tests.out 2>&1; echo $? > $ST/logs/root-finality-r10-tests.rc
# RUNS (exact 'Ran N tests in' + bare OK, rc 0, no skip; else FAIL with its log): every suite r9 0648 failed or whose bytes changed -
#   capture-r10 3, capture-closure 14 (r10 module), runtime-pin 10, tool 34, integration 17, reproof 9, parser-recovery 8, parser-first 8,
#   forward-sync-r2 6, ops-installer 13 (r10 qualification strings), reanchor-recovery 25, r3-regression 28, r62-isolated 2, forward-sync 8.
# REUSED (byte-identical code AND tests; receipt files pinned): ops-readiness 27 (r9 0648), sampler 93 (r7),
#   recovery-existing 34 (r6), JS core 20 (r2). The install manifest closure is checked directly.
set -uo pipefail
export PATH=/usr/bin:/bin
ip link set lo up 2>/dev/null; ip -o addr show lo 2>/dev/null | grep -q '127.0.0.1' || { echo "## SETUP: loopback is not up"; exit 9; }
P=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025; B=$P/base-finality-proof-stage; ST=$B/r10; R9=$B/r9; RP=$B/runtime-pin; CC=$P/production-capture-closure-stage; RR7=$P/base-reanchor-recovery-stage/r7
A2=$P/source/ops/rpc-backend-bootstrap/2026-10-25/a2-v2-release-bound-prepared/stage; FAKE=$B/pinned-checkpoint-parser/fixtures/fake_base.py; DEPS=$P/source; HELP=$P/logs/base-live-help-0603/help.txt
OUT=$ST/logs/root-finality-r10-tests-$(date -u +%Y%m%dT%H%M%SZ)-$$; rc=0
die() { echo "## SETUP: $*"; echo "## finality-r10 rc=9"; exit 9; }
fail() { echo "## FAIL: $*"; rc=1; }
pin() { [ "$(sha256sum < "$1" | cut -c1-64)" = "$2" ] || die "$1 is not $2"; }
tcopy() { mkdir -p "$2" && (cd "$1" && tar --exclude=./logs --exclude='__pycache__' --exclude=./bundle -cf - .) | (cd "$2" && tar -xf -) || die "copy $1"; }
[ ! -e "$OUT" ] && mkdir -p "$OUT/tmp" || die "output dir"
ip -o route 2>/dev/null | grep -q . && die "network route present: run under unshare -rn"
(cd "$ST" && sha256sum -c --quiet SHA256SUMS) || die "r10 files differ from SHA256SUMS"
pin $R9/SHA256SUMS ba41aefa62740550b423adaa4f717d45994b9557088a4de7a3206f5db45c5b44; pin $RP/SHA256SUMS 55c5e7b45ecc18f455ed8b1e8dcf48480f8337ab7e8beb574fa5d15573813936; pin $CC/SHA256SUMS 8608830aab2e61618a00ae17d9f2289ac390aaf105e190f561780da0a5725172; pin $RR7/MANIFEST.sha256 9b558d5bc723a80cd40999741e5ea11b96f357be617a24be1a7e8b929d85c6cb; pin $A2/a2a4.py abe223d6a0c6c203f7d76aaa4c68d25f8f7ecb74894e64dd838383abf6aeeadd; pin $HELP d393bab10e34092808652c18356a14495f236474efc2408f346afd4886f38025
pin $FAKE 73ad09a77c1c1ca48aee347eb836f280794347332277f6b32c078d8185787802
for d in $R9 $RP $CC; do (cd $d && sha256sum -c --quiet SHA256SUMS) || die "$d changed"; done
(cd $RR7 && sha256sum -c --quiet MANIFEST.sha256) || die "recovery r7 changed"
# ---- reused receipts: exact files, and the code + tests they ran are byte-identical in r10 -------------------------------
pin /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/base-finality-proof-stage/r9/logs/root-finality-r9-tests-20261026T064649Z-1069706/ops-readiness.txt 33e54954aae06ac1f85bd50497ee333fd7ea151aa71970c6d35ff0bf15178a1e; pin /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/base-finality-proof-stage/r7/logs/root-finality-r7-tests-20261026T061615Z-1022733/sampler.txt 512220bc4031073d7595e8f48e899011e4a10adada97f6a00684b1935c3f730e; pin /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/base-finality-proof-stage/r6/logs/root-finality-r6-tests-20261026T054735Z-964702/recovery-existing.txt d8f05743c4b67711499ed98701624e39ce806b5a869f4e6aa83488d7433b9927; pin /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/base-finality-proof-stage/r2/logs/root-finality-tests-20261026T023106Z-598302/js.tap 8f629b2091f2e9da5b77f2b8ec65d7bf8d5276889a34eead66f374cc8871ab5c
for f in readiness/require_ready.py readiness/publish_readiness.py readiness/readiness_sampler.py tests/test_ops_readiness.py wrapper/chain_service.py; do
  cmp -s $R9/$f $ST/$f || die "$f changed since its reused receipt"; done
echo "REUSED ops-readiness 27 (r9 0648), sampler 93, recovery-existing 34, JS core 20: receipts pinned, bytes identical"
# ---- composition + source pins + manifest closure -------------------------------------------------------------------
T=$OUT/tmp/pc
origin() { case "$1" in r9) echo "$R9/$2";; runtime-pin) echo "$RP/$2";; esac; }
tail -n +2 $ST/COMPOSITION.tsv | while IFS=$'\t' read -r path hh kind o patch; do
  case "$kind" in
    copy) cmp -s "$(origin $o $path)" "$ST/$path" || { echo "## SETUP: $path is not the $o copy"; exit 9; } ;;
    edit) rm -rf $T; mkdir -p $T && cp "$(origin $o $path)" $T/x && (cd $T && patch -s x < "$ST/integration/$patch.patch") && cmp -s $T/x "$ST/$path" \
            || { echo "## SETUP: $path != $o + $patch"; exit 9; } ;;
  esac; done || die "composition check"
/usr/bin/python3 -I - $ST 2e8502e68864abb49a230a69612bd7c98c94775d8dd81f956a0185d53652ac33 <<'PYM' || die "source pins / manifest closure"
import hashlib, json, pathlib, re, sys
S, CK = pathlib.Path(sys.argv[1]), sys.argv[2]; h = lambda p: hashlib.sha256((S / p).read_bytes()).hexdigest(); t = lambda p: (S / p).read_text()
HR, HF, F, Pr, Wr, CM = h('harness/a2a4.py'), h('harness-first/a2a4.py'), h('src/finality_state.py'), h('producer/base_launch.py'), h('wrapper/chain_service.py'), h('capture/a1_capture.py')
need = [(f"HARNESS_SHA256 = '{HR}'", 'src/finality_state.py'), (f"WRAPPER_SHA256 = '{Wr}'", 'src/finality_state.py'), (f"RECOVERY_A2A4_SHA256 = '{HR}'", 'producer/base_launch.py'),
        (f"A2A4_SOURCE_SHA256 = '{HF}'", 'producer/base_launch.py'), (f"FINALITY_STATE_SHA256 = '{F}'", 'producer/base_launch.py'), (f"WRAPPER_SHA256 = '{Wr}'", 'producer/base_launch.py'),
        (f"'{F}')", 'src/reproof.py'), (f"'{Pr}')", 'src/reproof.py'), (f"a2a4.py'), '{HR}')", 'recovery/forward_sync.py'), (f"chain_service.py'), '{Wr}')", 'recovery/forward_sync.py'),
        (f"A1_CAPTURE_SHA256 = '{CM}'", 'harness/a2a4.py')]
bad = [(s, f) for s, f in need if s not in t(f)]; assert not bad, bad
for f, line in (('harness/a2a4.py', 'A1_CAPTURE_REVIEWED = False'), ('producer/base_launch.py', 'FINALITY_PROOF_REVIEWED = False'), ('wrapper/chain_service.py', 'LAUNCH_PRODUCER_REVIEWED = False'),
                ('harness/a2a4.py', 'RETH_ENV_PASS = ()'), ('producer/base_launch.py', "HARNESS_BINARY_SHA256 = '9c44836d3dd41ae92df3c52fe0df7957dc10b77859d8d80cce6d5fb89d35e53f'")):
    assert re.search(r'^' + re.escape(line), t(f), re.M), (f, line)
assert re.search(r'^FINALITY_PROTOTYPE_REVIEWED = False ', t('src/finality_state.py'), re.M)
m = json.loads(t('install/MANIFEST.json')); dests = set()
for e in m['files'] + m['trees']:
    assert not e['src'].startswith('/') and e['dest'] not in dests, e; dests.add(e['dest'])
for e in m['files']:
    if not e['src'].startswith('bundle/'):
        assert h(e['src']) == e['sha256'], e['src']
want = {'/opt/enclave-rpc/a2a4/a2a4.py': HF, '/opt/enclave-rpc/a2a4-recovery/a2a4.py': HR, '/opt/enclave-rpc/finality/src/finality_state.py': F, '/opt/enclave-rpc/base-launch/base_launch.py': Pr,
        '/opt/enclave-rpc/chain_service.py': Wr, '/opt/enclave-rpc/a1-capture/a1_capture.py': CM, '/opt/enclave-rpc/finality/src/reproof.py': h('src/reproof.py'),
        '/opt/enclave-rpc/recovery/forward_sync.py': h('recovery/forward_sync.py'), '/etc/enclave-rpc/l1-checkpoint.json': CK}
got = {e['dest']: e['sha256'] for e in m['files']}; assert all(got.get(d) == s for d, s in want.items()), {d: (got.get(d), s) for d, s in want.items() if got.get(d) != s}
bo = json.loads(t('bundle-origin.json'))['entries']
assert {e['src'] for e in m['files'] if e['src'].startswith('bundle/')} | {x['src'] for x in m['trees']} == set(bo), 'bundle-origin != manifest bundle entries'
print('pins + manifest closure OK:', len(m['files']), 'files', len(m['trees']), 'trees')
PYM
WK=$OUT/work; tcopy $A2 $WK/source/ops/rpc-backend-bootstrap/2026-10-25/a2-v2-release-bound-prepared/stage
cp $ST/harness-first/a2a4.py $WK/source/ops/rpc-backend-bootstrap/2026-10-25/a2-v2-release-bound-prepared/stage/a2a4.py && cp $FAKE $WK/source/ops/rpc-backend-bootstrap/2026-10-25/a2-v2-release-bound-prepared/stage/test/fake_base.py || die "fixture stage"
tcopy $P/a1-capture-binding-stage/r4 $WK/a1-capture-binding-stage/r4; tcopy $RR7 $WK/base-reanchor-recovery-stage/r7
NODE=$(command -v node) && NODE=$(realpath -e "$NODE") || die "node not found"
check() { local name=$1 want=$2 f=$OUT/$1.txt r=$3; local ran last; ran=$(grep -oE '^Ran [0-9]+ tests? in ' $f | tail -1 | grep -oE '[0-9]+'); last=$(grep -E '^(OK|FAILED)( |$)' $f | tail -1)
  if [ "$r" = 0 ] && [ "$last" = OK ] && [ "$ran" = "$want" ] && ! grep -qE 'skipped|expected failure|unexpected success' $f; then echo "PASS $name Ran $ran (expected $want)"
  else fail "$name: rc $r, Ran ${ran:-?} (expected $want), last ${last:-none} (see $f)"; fi; }
SC=$OUT/stage; tcopy $ST $SC; CAPM=$SC/capture/a1_capture.py
E=(env -i PATH=/usr/bin:/bin TMPDIR=$OUT/tmp HOME=$OUT/tmp FINALITY_NODE=$NODE ANCHOR_DEPS_ROOT=$DEPS FINALITY_HARNESS=$SC/harness/a2a4.py PRODUCER_WORK=$WK CAPTURE_MODULE=$CAPM)
for s in capture-r10:test_capture_r10.py:3:1800 runtime-pin:test_runtime_pin.py:10:600 tool:test_finality_state.py:34:1200 integration:test_finality_integration.py:17:3000 reproof:test_reproof.py:9:3600 ops-installer:test_ops_installer.py:13:600; do
  IFS=: read -r name file want t <<< "$s"
  (cd $SC && "${E[@]}" timeout $t /usr/bin/python3 -I -B tests/$file -v < /dev/null) > $OUT/$name.txt 2>&1; check $name $want $?; done
for v in recovery:harness first:harness-first; do IFS=: read -r name dir <<< "$v"
  (cd $SC && env -i PATH=/usr/bin:/bin TMPDIR=$OUT/tmp HOME=$OUT/tmp HARNESS=$SC/$dir/a2a4.py HARNESS_DEPS=$SC/$dir timeout 300 /usr/bin/python3 -I -B tests/parser/test_pinned_checkpoints.py -v < /dev/null) > $OUT/parser-$name.txt 2>&1; check parser-$name 8 $?; done
(cd $SC && env -i PATH=/usr/bin:/bin TMPDIR=$OUT/tmp HOME=$OUT/tmp FORWARD_SYNC_SRC=$SC/recovery R2_PRODUCER=$SC/producer/base_launch.py BASE_HELP=$HELP \
   timeout 600 /usr/bin/python3 -I -B tests/forward-sync/test_forward_sync_r2.py -v < /dev/null) > $OUT/forward-sync-r2.txt 2>&1; check forward-sync-r2 6 $?
CL=$OUT/closure; tcopy $CC $CL; cp $ST/capture/a1_capture.py $CL/src/a1_capture.py || die "closure copy"
/usr/bin/python3 -I - $CL <<'PYC' || die "closure manifest re-pin"
import hashlib, json, pathlib, sys
C = pathlib.Path(sys.argv[1]); m = json.loads((C / 'install/MANIFEST.json').read_bytes()); n = 0
for e in m['files']:
    if e['src'] == 'a1_capture.py':
        e['sha256'] = hashlib.sha256((C / 'src/a1_capture.py').read_bytes()).hexdigest(); n += 1
assert n == 1; (C / 'install/MANIFEST.json').write_text(json.dumps(m, indent=1) + '\n'); print('closure copy re-pinned to the r10 module (its ONLY change)')
PYC
(cd $CL && env -i PATH=/usr/bin:/bin TMPDIR=$OUT/tmp HOME=$OUT/tmp timeout 600 /usr/bin/python3 -I -B tests/test_capture_closure.py -v < /dev/null) > $OUT/capture-closure.txt 2>&1; check capture-closure 14 $?
C=$OUT/recovery; tcopy $RR7 $C
cp $ST/harness/a2a4.py $C/harness/ && cp $ST/wrapper/chain_service.py $C/wrapper/ && cp $ST/producer/base_launch.py $C/producer/ \
  && cp $ST/tests/r7-ported/*.py $ST/tests/test_r62_followups.py $ST/tests/forward-sync/test_forward_sync.py $C/tests/ || die "recovery copy swap"
RE=(env TMPDIR=$OUT/tmp PINNED_FAKE_BASE=$FAKE PRODUCER_WORK=$WK CAPTURE_MODULE=$CAPM)
(cd $C && "${RE[@]}" timeout 3600 /usr/bin/python3 -E -s -B -u tests/test_reanchor_recovery.py < /dev/null) > $OUT/reanchor-recovery.txt 2>&1; check reanchor-recovery 25 $?
(cd $C && "${RE[@]}" timeout 3600 /usr/bin/python3 -E -s -B -u tests/test_r3_launcher.py < /dev/null) > $OUT/r3-regression.txt 2>&1; check r3-regression 28 $?
(cd $C && "${RE[@]}" FINALITY_SRC=$ST/src timeout 600 /usr/bin/python3 -E -s -B -u tests/test_r62_followups.py < /dev/null) > $OUT/r62-isolated.txt 2>&1; check r62-isolated 2 $?
(cd $C && "${RE[@]}" FORWARD_SYNC_SRC=$ST/recovery timeout 3600 /usr/bin/python3 -E -s -B -u tests/test_forward_sync.py < /dev/null) > $OUT/forward-sync.txt 2>&1; check forward-sync 8 $?
(cd "$ST" && sha256sum -c --quiet SHA256SUMS) || fail "r10 files CHANGED during the run"
echo "## outputs: $OUT"; echo "## r10 SHA256SUMS $(sha256sum < $ST/SHA256SUMS | cut -c1-64)"; echo "## finality-r10 rc=$rc"; exit $rc
