#!/bin/bash
# base-finality-proof-stage/r13: THE final production composition = root-qualified r12-final + the frozen cold-proof readers
# (cold-proof-timeout-stage/r3, SHA256SUMS 4a637e0109ca...) with the full pin cascade. ONE queued job (PREPARED; NOT run by Claude):
#   ST=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/base-finality-proof-stage/r13-final
#   python3 -u /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/../claude-test-queue.py --mib 768 --log $ST/logs/root-finality-r13-tests.guard -- unshare -rn bash $ST/jobs/root-finality-r13-tests.sh > $ST/logs/root-finality-r13-tests.out 2>&1; echo $? > $ST/logs/root-finality-r13-tests.rc
# RE-RUNS everything whose bytes changed (capture, both harnesses, tool, producer, forward_sync, reproof, readers, installer):
#   capture-r10 3, runtime-pin 10, tool 34, integration 17, reproof 17, ops-installer 18, parser-recovery 8, parser-first 8, forward-sync-r2 6,
#   capture-closure 14 (closure copy: r13 module + cold readers re-pinned), reanchor-recovery 25, r3-regression 28, r62-isolated 2,
#   forward-sync 8, the cold stage's own frozen reader job (transport + pinned A1 policy suites, on exactly the readers r13 pins); plus bundle assembly + FULL closure, all compositions,
#   identity vs r12-final, the pin cascade, reader-pin consistency, manifest closure.
# REUSED (byte-identical since r10, proven here): ops-readiness 27, sampler 93, JS core 20. The wrapper is bound to the root-qualified overlay byte and its own suite (existing 34 + pruned 15, mutants) reruns. HISTORY: r12-final 0738 PASS
#   (superseded: its capture/harness/... bytes changed) and every earlier pinned failure. A pass is QUALIFICATION only; then the NEW cold
#   canary on these bytes (logs/claude-r13-final-canary-handoff.json); nothing is installed or activated.
set -uo pipefail
export PATH=/usr/bin:/bin
ip link set lo up 2>/dev/null; ip -o addr show lo 2>/dev/null | grep -q '127.0.0.1' || { echo "## SETUP: loopback is not up"; exit 9; }
P=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025; B=$P/base-finality-proof-stage; ST=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/base-finality-proof-stage/r13-final; R12F=$B/r12-final; COLD=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/cold-proof-timeout-stage/r3; WIRE=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/production-bootstrap-wiring-stage/r2; WRAP=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/wrapper-pruned-identity-stage; R12=$B/r12; R3F=$B/r10-recovery-fixture-fix-r3; R11=$B/r11; R10=$B/r10; CC=$P/production-capture-closure-stage; RR7=$P/base-reanchor-recovery-stage/r7
F2=$B/r10-ops-followup-r2; FL=$B/r10-forward-log-fix; CF=$B/r10-capture-fixture-fix; RF=$B/r10-recovery-fixture-fix-r2
A2=$P/source/ops/rpc-backend-bootstrap/2026-10-25/a2-v2-release-bound-prepared/stage; FAKE=$B/pinned-checkpoint-parser/fixtures/fake_base.py; DEPS=$P/source; HELP=$P/logs/base-live-help-0603/help.txt
OUT=$ST/logs/root-finality-r13-tests-$(date -u +%Y%m%dT%H%M%SZ)-$$; rc=0
die() { echo "## SETUP: $*"; echo "## finality-r13 rc=9"; exit 9; }
fail() { echo "## FAIL: $*"; rc=1; }
pin() { [ "$(sha256sum < "$1" | cut -c1-64)" = "$2" ] || die "$1 is not $2"; }
receipt() { pin "$1" "$2"; grep -qE "^Ran $3 tests? in " "$1" && [ "$(grep -E '^(OK|FAILED)( |$)' "$1" | tail -1)" = OK ] || die "receipt $1 is not a clean pass of $3"; echo "REUSED $(basename $1 .txt) Ran $3 OK (receipt ${2:0:12})"; }
tcopy() { mkdir -p "$2" && (cd "$1" && tar --exclude=./logs --exclude='__pycache__' --exclude=./bundle -cf - .) | (cd "$2" && tar -xf -) || die "copy $1"; }
[ ! -e "$OUT" ] && mkdir -p "$OUT/tmp" || die "output dir"
ip -o route 2>/dev/null | grep -q . && die "network route present: run under unshare -rn"
(cd "$ST" && sha256sum -c --quiet SHA256SUMS) || die "r13 files differ from SHA256SUMS"
pin $R12F/SHA256SUMS 9de0d8d7664516fac691f6cd8dc1d984c00e79ba175c406b6cda9ec97037bd7e; (cd $R12F && sha256sum -c --quiet SHA256SUMS) || die "r12-final changed"
pin $COLD/SHA256SUMS 4a637e0109ca4030e31bd6738b00ad028479ebcddb6cfba331450a77a873b68c; (cd $COLD && sha256sum -c --quiet SHA256SUMS) || die "cold-proof stage changed"
pin $WIRE/SHA256SUMS 89586568d38d7f6f9df5ef2cec591e65f5327b88c7459e2f8233a555a4f7f06a; (cd $WIRE && sha256sum -c --quiet SHA256SUMS) || die "wiring stage changed"
pin $WRAP/SHA256SUMS 281c73cfa3be770f9b3b8ab0ca81052ed0ccb5248e524b4d96829695ec5895f7; (cd $WRAP && sha256sum -c --quiet SHA256SUMS) || die "wrapper stage changed"
pin $R12/SHA256SUMS 6303a5c5aa0e16bbe1ac733f123c6147421dd91b6a846d6bae4d4d03940fc372; (cd $R12 && sha256sum -c --quiet SHA256SUMS) || die "r12 changed"
pin $R3F/SHA256SUMS 8f91139beecdb62ca9d1e998da68789f534a3b32043aa020e85565043ed8af01; (cd $R3F && sha256sum -c --quiet SHA256SUMS) || die "recovery-fixture-fix-r3 changed"
pin $R11/SHA256SUMS a890137f6c14a0c927fb9e4109d63f8744fd754352851c7d01ab26807f23ed7c; (cd $R11 && sha256sum -c --quiet SHA256SUMS) || die "r11 changed"
pin $R10/SHA256SUMS 1dbb3abb6a8d2e162817d13531b9369b0bceb3eef11d4395f2719b062b4a6dcb; pin $F2/SHA256SUMS f072202a6fcaf10a81d47f8d2b0dd8f0ab3c2697def93668789d2c8c0336a0b5; pin $FL/SHA256SUMS 5397806287a37697d01fb94f4f012d432d0a8a9c7497cd8b958e8bb9bd097114; pin $CF/SHA256SUMS 003f962c1cc59b6070f7285d5102c3fe398bbe32243f1e2ac0a547f1de4007b2; pin $RF/SHA256SUMS eb8e255a51ffc9c10ff26010fb71f207b7bdfe9af220d74f0809dba9ba1094e8
for d in $R10 $F2 $FL $CF $RF $CC; do (cd $d && sha256sum -c --quiet SHA256SUMS) || die "$d changed"; done
pin $CC/SHA256SUMS 8608830aab2e61618a00ae17d9f2289ac390aaf105e190f561780da0a5725172; pin $RR7/MANIFEST.sha256 9b558d5bc723a80cd40999741e5ea11b96f357be617a24be1a7e8b929d85c6cb; (cd $RR7 && sha256sum -c --quiet MANIFEST.sha256) || die "recovery r7 changed"
pin $A2/a2a4.py abe223d6a0c6c203f7d76aaa4c68d25f8f7ecb74894e64dd838383abf6aeeadd; pin $HELP d393bab10e34092808652c18356a14495f236474efc2408f346afd4886f38025; pin $FAKE 73ad09a77c1c1ca48aee347eb836f280794347332277f6b32c078d8185787802
# ---- composition: every file is a byte copy of its origin, an origin + integration-r11/<name>.patch edit, or new ----------------
origin() { case "$1" in wiring) echo "$WIRE/$3";; wrapper) echo "$WRAP/$3";; r12-final) echo "$R12F/$2";; r12) echo "$R12/$2";; r10-recovery-fixture-fix-r3) echo "$R3F/$2";; r11) echo "$R11/$2";; r10) echo "$R10/$2";; r10-ops-followup-r2) echo "$F2/$2";; r10-forward-log-fix) echo "$FL/$3";; r10-capture-fixture-fix) echo "$CF/$2";; r10-recovery-fixture-fix-r2) echo "$RF/$2";; esac; }
T=$OUT/tmp/pc
comp() { local D=$1 PD=$2
tail -n +2 $D/COMPOSITION.tsv | while IFS=$'\t' read -r path hh kind o src patch; do
  case "$kind" in
    copy) cmp -s "$(origin $o $path $src)" "$D/$path" || { echo "## SETUP: $path is not the $o copy"; exit 9; } ;;
    edit) rm -rf $T; mkdir -p $T && cp "$(origin $o $path $src)" $T/x && (cd $T && patch -s x < "$D/$PD/$patch.patch") && cmp -s $T/x "$D/$path" \
            || { echo "## SETUP: $path != $o + $patch"; exit 9; } ;;
  esac; done || die "composition check of $D"; }
comp $R11 integration-r11; comp $R12 integration-r12; comp $R12F integration-r12-final; comp $ST integration-r13
# every r11 file NOT in the changed set is byte-identical to r10 (so r10's receipts below cover it), and r10 has no file r11 dropped silently
/usr/bin/python3 -I - $ST $R12F <<'PYD' || die "r12-final identity"
import pathlib, sys
S, R = map(pathlib.Path, sys.argv[1:3]); rows = [l.split('\t') for l in (S / 'COMPOSITION.tsv').read_text().splitlines()[1:]]
changed = {r[0] for r in rows if not (r[2] == 'copy' and r[3] == 'r12-final')}
bad = [r[0] for r in rows if r[0] not in changed and (S / r[0]).read_bytes() != (R / r[0]).read_bytes()]; assert not bad, bad
sums = {l.split(None, 1)[1].lstrip('*')[2:] for l in (R / 'SHA256SUMS').read_text().splitlines()}
assert not sums - {r[0] for r in rows} - {'jobs/root-finality-r12-final.sh', 'COMPOSITION.tsv', 'README.md'}
print('r13 = r12-final except', sorted(changed))
PYD
diff -rq $R10/readiness $ST/readiness > /dev/null || die "readiness differs from r10 (reused receipts)"
cmp -s $WRAP/overlay/wrapper/chain_service.py $ST/wrapper/chain_service.py || die "wrapper is not the root-qualified overlay byte (wrapper-pruned-identity-stage)"
for f in tests/test_ops_readiness.py src/finality-core.mjs; do cmp -s $R10/$f $ST/$f || die "$f differs from r10 (reused receipts)"; done
# ---- reused receipts (exact files; their code + tests are proven byte-identical to r10 above) ------------------------------------
pin /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/logs/root-finality-r10-0702.out fd03ec091f172f7e26ad9ab9bc34ee1e4695c375fb5997bdb23e9c557900e687; pin /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/base-finality-proof-stage/r10-ops-followup-r2/logs/root-r10-ops-followup-r2-tests-20261026T072804Z-1136677/ops-installer.txt 0fc2671ee466e80a6a75c08874f716652d732b02fcd320f025b17e9976981c98; pin /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/base-finality-proof-stage/r10-recovery-fixture-fix-r2/logs/run-20261026T072918Z-1140069/reanchor-bounds.txt 2cfd4976008e2bd735fc0173c1027d220ccfe750d6faf012f1887df747d57f26; pin /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/logs/root-recovery-fixture-r3-0732.out d543af5f43b660b81f4626f2f6baa28a94c280716259518274dfff43929200f1; pin /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/base-finality-proof-stage/r10-recovery-fixture-fix-r3/logs/run-20261026T073052Z-1142132/reanchor-bounds.txt f83324d31dd1e170c324dc4bb37704dc64c5998fea802eec8d4c8b1ed56fbef6
pin /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/logs/root-finality-r12-final-0738.out b803f7e5bff7a95149d40f81bd64b49d385e0b20ab4fc20eda19ea23eda50967
echo "HISTORY r12-final 0738 PASS (superseded: changed bytes); ops-followup-r2 0728 ops-installer 17/18, recovery-fixture-r2 FAIL, r3 0732 no-test: pinned, superseded; r3 0733 single PASS (informational)"
receipt /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/base-finality-proof-stage/r9/logs/root-finality-r9-tests-20261026T064649Z-1069706/ops-readiness.txt 33e54954aae06ac1f85bd50497ee333fd7ea151aa71970c6d35ff0bf15178a1e 27
receipt /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/base-finality-proof-stage/r7/logs/root-finality-r7-tests-20261026T061615Z-1022733/sampler.txt 512220bc4031073d7595e8f48e899011e4a10adada97f6a00684b1935c3f730e 93
echo "NOT REUSED recovery-existing 34 (old wrapper 4fc3b970): the new wrapper's existing 34-test suite runs in wrapper-pruned (49)"
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
/usr/bin/python3 -I - $ST <<'PYR' || die "reader pin consistency"
import hashlib, json, pathlib, re, sys
S = pathlib.Path(sys.argv[1]); bo = json.loads((S / 'bundle-origin.json').read_text())['entries']; m = json.loads((S / 'install/MANIFEST.json').read_text())
rd, rr = bo['bundle/a1-capture/l1-anchor-a1/a1-read.mjs']['sha256'], bo['bundle/a1-capture/a1-original-game-prepared/a1-recheck-read.mjs']['sha256']
assert bo['bundle/a1-capture/a1-original-game-prepared/a1-read.mjs']['sha256'] == rd
for f in ('capture/a1_capture.py', 'harness/a2a4.py', 'harness-first/a2a4.py'):
    t = (S / f).read_text(); assert f"'a1-read.mjs': '{rd}'" in t and f"'a1-recheck-read.mjs': '{rr}'" in t, f
for k in bo:
    if k.endswith(('a1-read.mjs', 'a1-recheck-read.mjs')):
        assert [e['sha256'] for e in m['files'] if e['src'] == k] == [bo[k]['sha256']], k
assert re.search(r"'elUrl'|el_url", (S / 'capture/a1_capture.py').read_text()) and '18645' in (S / 'install/config-templates/l1-authority.json').read_text()
print('reader pins consistent:', rd[:12], rr[:12], '(capture, both harnesses, MANIFEST, bundle-origin); own EL 18645 template kept')
PYR
/usr/bin/python3 -I $ST/tools/assemble_bundle.py > $OUT/assemble-bundle.txt 2>&1 && echo "bundle assembled: $(tail -1 $OUT/assemble-bundle.txt)" || fail "bundle assembly (see $OUT/assemble-bundle.txt)"
/usr/bin/python3 -I - $ST <<'PYB' || fail "bundle closure (the installer installs only verified bundle bytes)"
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
for s in capture-r10:test_capture_r10.py:3:1800 runtime-pin:test_runtime_pin.py:10:600 tool:test_finality_state.py:34:1200 integration:test_finality_integration.py:17:3000 reproof:test_reproof.py:17:3600 ops-installer:test_ops_installer.py:18:600; do
  IFS=: read -r name file want t <<< "$s"
  (cd $SC && "${E[@]}" timeout $t /usr/bin/python3 -I -B tests/$file -v < /dev/null) > $OUT/$name.txt 2>&1; check $name $want $?; done
for v in recovery:harness first:harness-first; do IFS=: read -r name dir <<< "$v"
  (cd $SC && env -i PATH=/usr/bin:/bin TMPDIR=$OUT/tmp HOME=$OUT/tmp HARNESS=$SC/$dir/a2a4.py HARNESS_DEPS=$SC/$dir timeout 300 /usr/bin/python3 -I -B tests/parser/test_pinned_checkpoints.py -v < /dev/null) > $OUT/parser-$name.txt 2>&1; check parser-$name 8 $?; done
CL=$OUT/closure; tcopy $CC $CL; cp $ST/capture/a1_capture.py $CL/src/a1_capture.py || die "closure copy"
/usr/bin/python3 -I - $CL $ST <<'PYC' || die "closure re-pin"
import hashlib, json, pathlib, sys
C, S = map(pathlib.Path, sys.argv[1:3]); h = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()
bo13 = json.loads((S / 'bundle-origin.json').read_text())['entries']; m = json.loads((C / 'install/MANIFEST.json').read_text()); n = 0
for e in m['files']:
    if e['src'] == 'a1_capture.py':
        e['sha256'] = h(C / 'src/a1_capture.py'); n += 1
    for d in ('l1-anchor-a1', 'a1-original-game-prepared'):
        k = f'bundle/a1-capture/{e["src"]}'
        if e['src'].startswith(d + '/') and e['src'].endswith(('a1-read.mjs', 'a1-recheck-read.mjs')) and k in bo13:
            e['sha256'] = bo13[k]['sha256']; n += 1
assert n == 4, n
(C / 'install/MANIFEST.json').write_text(json.dumps(m, indent=1) + '\n')
cb = C / 'bundle-origin.json'; o = json.loads(cb.read_text()); k = 0
for rel, v in o.items():
    if rel.endswith(('a1-read.mjs', 'a1-recheck-read.mjs')) and f'bundle/a1-capture/{rel}' in bo13:
        new = bo13[f'bundle/a1-capture/{rel}']
        if isinstance(v, dict):
            v['origin'], v['sha256'] = new['origin'], new['sha256']
        else:
            o[rel] = new['origin']
        k += 1
assert k == 3, k
cb.write_text(json.dumps(o, indent=1) + '\n'); print('closure copy re-pinned: r13 module + 3 cold readers (manifest + origins), nothing else')
PYC
(cd $CL && env -i PATH=/usr/bin:/bin TMPDIR=$OUT/tmp HOME=$OUT/tmp timeout 600 /usr/bin/python3 -I -B tests/test_capture_closure.py -v < /dev/null) > $OUT/capture-closure.txt 2>&1; check capture-closure 14 $?
(cd $SC && env -i PATH=/usr/bin:/bin TMPDIR=$OUT/tmp HOME=$OUT/tmp FORWARD_SYNC_SRC=$SC/recovery R2_PRODUCER=$SC/producer/base_launch.py BASE_HELP=$HELP \
   timeout 600 /usr/bin/python3 -I -B tests/forward-sync/test_forward_sync_r2.py -v < /dev/null) > $OUT/forward-sync-r2.txt 2>&1; check forward-sync-r2 6 $?
C=$OUT/recovery; tcopy $RR7 $C
cp $ST/harness/a2a4.py $C/harness/ && cp $ST/wrapper/chain_service.py $C/wrapper/ && cp $ST/producer/base_launch.py $C/producer/ \
  && cp $ST/tests/r7-ported/*.py $ST/tests/test_r62_followups.py $ST/tests/forward-sync/test_forward_sync.py $C/tests/ || die "recovery copy swap"
RE=(env TMPDIR=$OUT/tmp PINNED_FAKE_BASE=$FAKE PRODUCER_WORK=$WK CAPTURE_MODULE=$CAPM)
(cd $C && "${RE[@]}" timeout 3600 /usr/bin/python3 -E -s -B -u tests/test_reanchor_recovery.py < /dev/null) > $OUT/reanchor-recovery.txt 2>&1; check reanchor-recovery 25 $?
(cd $C && "${RE[@]}" timeout 3600 /usr/bin/python3 -E -s -B -u tests/test_r3_launcher.py < /dev/null) > $OUT/r3-regression.txt 2>&1; check r3-regression 28 $?
(cd $C && "${RE[@]}" FINALITY_SRC=$ST/src timeout 600 /usr/bin/python3 -E -s -B -u tests/test_r62_followups.py < /dev/null) > $OUT/r62-isolated.txt 2>&1; check r62-isolated 2 $?
(cd $C && "${RE[@]}" FORWARD_SYNC_SRC=$ST/recovery timeout 3600 /usr/bin/python3 -E -s -B -u tests/test_forward_sync.py < /dev/null) > $OUT/forward-sync.txt 2>&1; check forward-sync 8 $?
(cd $C && env -i PATH=/usr/bin:/bin TMPDIR=$OUT/tmp HOME=$OUT/tmp CAPTURE_MODULE=$SC/capture/a1_capture.py FINALITY_NODE=$NODE PINNED_FAKE_BASE=$FAKE PRODUCER_WORK=$WK R12_UNITS=$SC/units WIRING_OVERLAY=$SC timeout 3600 /usr/bin/python3 -E -s -B -u tests/test_bootstrap_wiring.py < /dev/null) > $OUT/wiring-bootstrap-wiring.txt 2>&1; check wiring-bootstrap-wiring 22 $?
(cd $C && env -i PATH=/usr/bin:/bin TMPDIR=$OUT/tmp HOME=$OUT/tmp CAPTURE_MODULE=$SC/capture/a1_capture.py PINNED_FAKE_BASE=$FAKE PRODUCER_WORK=$WK timeout 3600 /usr/bin/python3 -E -s -B -u tests/test_r3_launcher.py < /dev/null) > $OUT/wiring-r3-regression.txt 2>&1; check wiring-r3-regression 28 $?
# pruned-identity wrapper: r13 holds EXACTLY the qualified overlay byte; its stage's OWN frozen jobs.sh reruns on a private copy
cmp -s $WRAP/overlay/wrapper/chain_service.py $ST/wrapper/chain_service.py || fail "r13 wrapper is not the qualified overlay byte"
WC=$OUT/wrapper-stage; tcopy $WRAP $WC; mkdir -p $WC/tmp
(cd $WC && env -i PATH=/usr/bin:/bin bash ./jobs.sh < /dev/null) > $OUT/wrapper-pruned.txt 2>&1; r=$?
if [ $r = 0 ] && grep -qx "rc=0" $OUT/wrapper-pruned.txt && grep -qx "BASELINE REPRODUCES BLOCKER" $OUT/wrapper-pruned.txt && grep -q "^Ran 49 tests in " $OUT/wrapper-pruned.txt && grep -q "^Ran 34 tests in " $OUT/wrapper-pruned.txt \
   && grep -qx "$(sha256sum < $ST/wrapper/chain_service.py | cut -c1-64)  overlay/wrapper/chain_service.py" $OUT/wrapper-pruned.txt; then echo "PASS wrapper-pruned (49 + baseline blocker + mutants, on the r13 wrapper byte)"
else fail "wrapper-pruned: rc $r (see $OUT/wrapper-pruned.txt)"; fi
# cold-proof readers: the cold stage's OWN frozen job (pinned by its SHA256SUMS), verbatim; it overlays EXACTLY the reader bytes r13 pins
for k in l1-anchor-a1/a1-read.mjs a1-original-game-prepared/a1-read.mjs a1-original-game-prepared/a1-recheck-read.mjs; do
  cmp -s $COLD/src/$k $ST/bundle/a1-capture/$k || fail "r13 bundle reader $k is not the cold stage's tested byte"; done
bash $COLD/jobs/root-cold-proof-tests.sh > $OUT/cold-proof.txt 2>&1; r=$?
if [ $r = 0 ] && grep -q "^PASS cold-proof-tests .*stage-sums 4a637e0109ca4030e31bd6738b00ad028479ebcddb6cfba331450a77a873b68c$" $OUT/cold-proof.txt && grep -qx "## cold-proof-tests r3 rc=0" $OUT/cold-proof.txt; then echo "PASS cold-proof (cold stage job: $(grep '^PASS cold-proof-tests' $OUT/cold-proof.txt | cut -c1-120))"
else fail "cold-proof: rc $r (see $OUT/cold-proof.txt)"; fi
(cd "$ST" && sha256sum -c --quiet SHA256SUMS) || fail "r13 files CHANGED during the run"
echo "## outputs: $OUT"; echo "## r13 SHA256SUMS $(sha256sum < $ST/SHA256SUMS | cut -c1-64)"; echo "## finality-r13 rc=$rc"; exit $rc
