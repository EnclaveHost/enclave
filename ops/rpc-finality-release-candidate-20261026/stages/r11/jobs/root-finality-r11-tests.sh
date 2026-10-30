#!/bin/bash
# base-finality-proof-stage/r11: the ONE final composition = frozen r10 + r10-ops-followup-r2 (reproof retention, installer, MANIFEST, their tests)
# + r10-forward-log-fix (forward_sync.py + its test) + r10-capture-fixture-fix (test) + r10-recovery-fixture-fix-r2 (test); installer qualification
# strings r11. Root's LOCAL, OFFLINE qualification (PREPARED; NOT run by Claude). FIRST assemble the bundle (workstation, hash-checked):
#   /usr/bin/python3 /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/base-finality-proof-stage/r11/tools/assemble_bundle.py
# then through the queue:
#   ST=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/base-finality-proof-stage/r11
#   python3 -u /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/../claude-test-queue.py --mib 1536 --log $ST/logs/root-finality-r11-tests.guard -- unshare -rn bash $ST/jobs/root-finality-r11-tests.sh > $ST/logs/root-finality-r11-tests.out 2>&1; echo $? > $ST/logs/root-finality-r11-tests.rc
# RUNS (changed code, tests or fixtures they import): capture-r10 3, reproof 17, ops-installer 18, forward-sync-r2 6 (stage copy);
#   reanchor-recovery 25, r62-isolated 2, forward-sync 8 (recovery copy). Plus composition, pin cascade, manifest closure and the FULL bundle.
# REUSED with explicit passing receipts (receipt sha + 'Ran N' + OK checked; the job proves every r11 file outside the changed set is
#   byte-identical to r10, and no reused suite imports a changed file): r10 run 0702: tool 34, runtime-pin 10, integration 17, parser-recovery 8,
#   parser-first 8, capture-closure 14, r3-regression 28; earlier: ops-readiness 27 (r9), sampler 93 (r7), recovery-existing 34 (r6), JS core 20 (r2).
# A pass is QUALIFICATION only: nothing is installed or activated (see logs/claude-finality-r11-result.md for install/activation order).
set -uo pipefail
export PATH=/usr/bin:/bin
ip link set lo up 2>/dev/null; ip -o addr show lo 2>/dev/null | grep -q '127.0.0.1' || { echo "## SETUP: loopback is not up"; exit 9; }
P=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025; B=$P/base-finality-proof-stage; ST=$B/r11; R10=$B/r10; CC=$P/production-capture-closure-stage; RR7=$P/base-reanchor-recovery-stage/r7
F2=$B/r10-ops-followup-r2; FL=$B/r10-forward-log-fix; CF=$B/r10-capture-fixture-fix; RF=$B/r10-recovery-fixture-fix-r2
A2=$P/source/ops/rpc-backend-bootstrap/2026-10-25/a2-v2-release-bound-prepared/stage; FAKE=$B/pinned-checkpoint-parser/fixtures/fake_base.py; DEPS=$P/source; HELP=$P/logs/base-live-help-0603/help.txt
OUT=$ST/logs/root-finality-r11-tests-$(date -u +%Y%m%dT%H%M%SZ)-$$; rc=0
die() { echo "## SETUP: $*"; echo "## finality-r11 rc=9"; exit 9; }
fail() { echo "## FAIL: $*"; rc=1; }
pin() { [ "$(sha256sum < "$1" | cut -c1-64)" = "$2" ] || die "$1 is not $2"; }
receipt() { pin "$1" "$2"; grep -qE "^Ran $3 tests? in " "$1" && [ "$(grep -E '^(OK|FAILED)( |$)' "$1" | tail -1)" = OK ] || die "receipt $1 is not a clean pass of $3"; echo "REUSED $(basename $1 .txt) Ran $3 OK (receipt ${2:0:12})"; }
tcopy() { mkdir -p "$2" && (cd "$1" && tar --exclude=./logs --exclude='__pycache__' --exclude=./bundle -cf - .) | (cd "$2" && tar -xf -) || die "copy $1"; }
[ ! -e "$OUT" ] && mkdir -p "$OUT/tmp" || die "output dir"
ip -o route 2>/dev/null | grep -q . && die "network route present: run under unshare -rn"
(cd "$ST" && sha256sum -c --quiet SHA256SUMS) || die "r11 files differ from SHA256SUMS"
pin $R10/SHA256SUMS 1dbb3abb6a8d2e162817d13531b9369b0bceb3eef11d4395f2719b062b4a6dcb; pin $F2/SHA256SUMS f072202a6fcaf10a81d47f8d2b0dd8f0ab3c2697def93668789d2c8c0336a0b5; pin $FL/SHA256SUMS 5397806287a37697d01fb94f4f012d432d0a8a9c7497cd8b958e8bb9bd097114; pin $CF/SHA256SUMS 003f962c1cc59b6070f7285d5102c3fe398bbe32243f1e2ac0a547f1de4007b2; pin $RF/SHA256SUMS eb8e255a51ffc9c10ff26010fb71f207b7bdfe9af220d74f0809dba9ba1094e8
for d in $R10 $F2 $FL $CF $RF $CC; do (cd $d && sha256sum -c --quiet SHA256SUMS) || die "$d changed"; done
pin $CC/SHA256SUMS 8608830aab2e61618a00ae17d9f2289ac390aaf105e190f561780da0a5725172; pin $RR7/MANIFEST.sha256 9b558d5bc723a80cd40999741e5ea11b96f357be617a24be1a7e8b929d85c6cb; (cd $RR7 && sha256sum -c --quiet MANIFEST.sha256) || die "recovery r7 changed"
pin $A2/a2a4.py abe223d6a0c6c203f7d76aaa4c68d25f8f7ecb74894e64dd838383abf6aeeadd; pin $HELP d393bab10e34092808652c18356a14495f236474efc2408f346afd4886f38025; pin $FAKE 73ad09a77c1c1ca48aee347eb836f280794347332277f6b32c078d8185787802
# ---- composition: every file is a byte copy of its origin, an origin + integration-r11/<name>.patch edit, or new ----------------
origin() { case "$1" in r10) echo "$R10/$2";; r10-ops-followup-r2) echo "$F2/$2";; r10-forward-log-fix) echo "$FL/$3";; r10-capture-fixture-fix) echo "$CF/$2";; r10-recovery-fixture-fix-r2) echo "$RF/$2";; esac; }
T=$OUT/tmp/pc
tail -n +2 $ST/COMPOSITION.tsv | while IFS=$'\t' read -r path hh kind o src patch; do
  case "$kind" in
    copy) cmp -s "$(origin $o $path $src)" "$ST/$path" || { echo "## SETUP: $path is not the $o copy"; exit 9; } ;;
    edit) rm -rf $T; mkdir -p $T && cp "$(origin $o $path $src)" $T/x && (cd $T && patch -s x < "$ST/integration-r11/$patch.patch") && cmp -s $T/x "$ST/$path" \
            || { echo "## SETUP: $path != $o + $patch"; exit 9; } ;;
  esac; done || die "composition check"
# every r11 file NOT in the changed set is byte-identical to r10 (so r10's receipts below cover it), and r10 has no file r11 dropped silently
/usr/bin/python3 -I - $ST $R10 <<'PYD' || die "r10 identity"
import pathlib, sys
S, R = map(pathlib.Path, sys.argv[1:3]); rows = [l.split('\t') for l in (S / 'COMPOSITION.tsv').read_text().splitlines()[1:]]
changed = {r[0] for r in rows if not (r[2] == 'copy' and r[3] == 'r10')}
same = [r[0] for r in rows if r[0] not in changed]
bad = [p for p in same if (S / p).read_bytes() != (R / p).read_bytes()]; assert not bad, bad
dropped = sorted({l.split(None, 1)[1].lstrip('*')[2:] for l in (R / 'SHA256SUMS').read_text().splitlines()} - {r[0] for r in rows}
                 - {'jobs/root-finality-r10-tests.sh', 'COMPOSITION.tsv', 'README.md'})
assert not dropped, dropped
print('r11 = r10 except', sorted(changed))
PYD
# ---- reused receipts (exact files; their code + tests are proven byte-identical to r10 above) ------------------------------------
receipt /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/base-finality-proof-stage/r10/logs/root-finality-r10-tests-20261026T070123Z-1091108/tool.txt 9e0120cc0f9f5080caf81387ae7682db83ba66588e6e87b050ed7651af329a2c 34
receipt /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/base-finality-proof-stage/r10/logs/root-finality-r10-tests-20261026T070123Z-1091108/runtime-pin.txt 4193925d0c6f2b071b214accc4ef95ac8ba0a826b1b6ee196d574ae3857f8c1a 10
receipt /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/base-finality-proof-stage/r10/logs/root-finality-r10-tests-20261026T070123Z-1091108/integration.txt 0780df77f1b470c3916838d4b0b54139d5de2ba8f4511bf45529136106ad4905 17
receipt /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/base-finality-proof-stage/r10/logs/root-finality-r10-tests-20261026T070123Z-1091108/parser-recovery.txt 23012c11e1dc3460028bf40a9e76ad85b582b9daf788c0830b5d8a2c9329a013 8
receipt /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/base-finality-proof-stage/r10/logs/root-finality-r10-tests-20261026T070123Z-1091108/parser-first.txt 23012c11e1dc3460028bf40a9e76ad85b582b9daf788c0830b5d8a2c9329a013 8
receipt /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/base-finality-proof-stage/r10/logs/root-finality-r10-tests-20261026T070123Z-1091108/capture-closure.txt 03a639959ee7d93680d1705ed055d75a92d62eb42be38eec8664c58108a20394 14
receipt /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/base-finality-proof-stage/r10/logs/root-finality-r10-tests-20261026T070123Z-1091108/r3-regression.txt fbbe364609afbbe97cbd502ac6f8a9551b0014c17a5397b18bdc084b1a78f084 28
receipt /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/base-finality-proof-stage/r9/logs/root-finality-r9-tests-20261026T064649Z-1069706/ops-readiness.txt 33e54954aae06ac1f85bd50497ee333fd7ea151aa71970c6d35ff0bf15178a1e 27
receipt /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/base-finality-proof-stage/r7/logs/root-finality-r7-tests-20261026T061615Z-1022733/sampler.txt 512220bc4031073d7595e8f48e899011e4a10adada97f6a00684b1935c3f730e 93
receipt /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/base-finality-proof-stage/r6/logs/root-finality-r6-tests-20261026T054735Z-964702/recovery-existing.txt d8f05743c4b67711499ed98701624e39ce806b5a869f4e6aa83488d7433b9927 34
pin /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/base-finality-proof-stage/r2/logs/root-finality-tests-20261026T023106Z-598302/js.tap 8f629b2091f2e9da5b77f2b8ec65d7bf8d5276889a34eead66f374cc8871ab5c; grep -qx "# pass 20" /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/base-finality-proof-stage/r2/logs/root-finality-tests-20261026T023106Z-598302/js.tap && grep -qx "# fail 0" /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/base-finality-proof-stage/r2/logs/root-finality-tests-20261026T023106Z-598302/js.tap || die "JS receipt is not a clean 20"; echo "REUSED JS core 20 (tap receipt)"
# ---- source pins, manifest closure, bundle closure --------------------------------------------------------------------------------
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
/usr/bin/python3 -I - $ST <<'PYB' || fail "bundle closure: run tools/assemble_bundle.py first (the installer installs only verified bundle bytes)"
import hashlib, json, os, pathlib, sys
S = pathlib.Path(sys.argv[1]); m = json.loads((S / 'install/MANIFEST.json').read_bytes()); h = lambda p: hashlib.sha256(p.read_bytes()).hexdigest(); n = 0
for e in m['files']:
    if e['src'].startswith('bundle/'):
        p = S / e['src']; assert p.is_file() and not p.is_symlink() and h(p) == e['sha256'], e['src']; n += 1
for t in m['trees']:
    root = S / t['src']; found = {}
    for dp, dns, fns in os.walk(root):
        for x in dns + fns:
            q = pathlib.Path(dp, x); assert not q.is_symlink(), q
            if q.is_file(): found[q.relative_to(root).as_posix()] = h(q)
    assert found == t['files'], (t['src'], sorted(set(found) ^ set(t['files']))[:5]); n += 1
print('bundle closure OK:', n, 'entries')
PYB
WK=$OUT/work; tcopy $A2 $WK/source/ops/rpc-backend-bootstrap/2026-10-25/a2-v2-release-bound-prepared/stage
cp $ST/harness-first/a2a4.py $WK/source/ops/rpc-backend-bootstrap/2026-10-25/a2-v2-release-bound-prepared/stage/a2a4.py && cp $FAKE $WK/source/ops/rpc-backend-bootstrap/2026-10-25/a2-v2-release-bound-prepared/stage/test/fake_base.py || die "fixture stage"
tcopy $P/a1-capture-binding-stage/r4 $WK/a1-capture-binding-stage/r4; tcopy $RR7 $WK/base-reanchor-recovery-stage/r7
NODE=$(command -v node) && NODE=$(realpath -e "$NODE") || die "node not found"
check() { local name=$1 want=$2 f=$OUT/$1.txt r=$3; local ran last; ran=$(grep -oE '^Ran [0-9]+ tests? in ' $f | tail -1 | grep -oE '[0-9]+'); last=$(grep -E '^(OK|FAILED)( |$)' $f | tail -1)
  if [ "$r" = 0 ] && [ "$last" = OK ] && [ "$ran" = "$want" ] && ! grep -qE 'skipped|expected failure|unexpected success' $f; then echo "PASS $name Ran $ran (expected $want)"
  else fail "$name: rc $r, Ran ${ran:-?} (expected $want), last ${last:-none} (see $f)"; fi; }
SC=$OUT/stage; tcopy $ST $SC; CAPM=$SC/capture/a1_capture.py
E=(env -i PATH=/usr/bin:/bin TMPDIR=$OUT/tmp HOME=$OUT/tmp FINALITY_NODE=$NODE ANCHOR_DEPS_ROOT=$DEPS FINALITY_HARNESS=$SC/harness/a2a4.py PRODUCER_WORK=$WK CAPTURE_MODULE=$CAPM)
for s in capture-r10:test_capture_r10.py:3:1800 reproof:test_reproof.py:17:3600 ops-installer:test_ops_installer.py:18:600; do
  IFS=: read -r name file want t <<< "$s"
  (cd $SC && "${E[@]}" timeout $t /usr/bin/python3 -I -B tests/$file -v < /dev/null) > $OUT/$name.txt 2>&1; check $name $want $?; done
(cd $SC && env -i PATH=/usr/bin:/bin TMPDIR=$OUT/tmp HOME=$OUT/tmp FORWARD_SYNC_SRC=$SC/recovery R2_PRODUCER=$SC/producer/base_launch.py BASE_HELP=$HELP \
   timeout 600 /usr/bin/python3 -I -B tests/forward-sync/test_forward_sync_r2.py -v < /dev/null) > $OUT/forward-sync-r2.txt 2>&1; check forward-sync-r2 6 $?
C=$OUT/recovery; tcopy $RR7 $C
cp $ST/harness/a2a4.py $C/harness/ && cp $ST/wrapper/chain_service.py $C/wrapper/ && cp $ST/producer/base_launch.py $C/producer/ \
  && cp $ST/tests/r7-ported/*.py $ST/tests/test_r62_followups.py $ST/tests/forward-sync/test_forward_sync.py $C/tests/ || die "recovery copy swap"
RE=(env TMPDIR=$OUT/tmp PINNED_FAKE_BASE=$FAKE PRODUCER_WORK=$WK CAPTURE_MODULE=$CAPM)
(cd $C && "${RE[@]}" timeout 3600 /usr/bin/python3 -E -s -B -u tests/test_reanchor_recovery.py < /dev/null) > $OUT/reanchor-recovery.txt 2>&1; check reanchor-recovery 25 $?
(cd $C && "${RE[@]}" FINALITY_SRC=$ST/src timeout 600 /usr/bin/python3 -E -s -B -u tests/test_r62_followups.py < /dev/null) > $OUT/r62-isolated.txt 2>&1; check r62-isolated 2 $?
(cd $C && "${RE[@]}" FORWARD_SYNC_SRC=$ST/recovery timeout 3600 /usr/bin/python3 -E -s -B -u tests/test_forward_sync.py < /dev/null) > $OUT/forward-sync.txt 2>&1; check forward-sync 8 $?
(cd "$ST" && sha256sum -c --quiet SHA256SUMS) || fail "r11 files CHANGED during the run"
echo "## outputs: $OUT"; echo "## r11 SHA256SUMS $(sha256sum < $ST/SHA256SUMS | cut -c1-64)"; echo "## finality-r11 rc=$rc"; exit $rc
