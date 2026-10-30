#!/bin/bash
# host-authority permit r1: ROOT-OWNED, OFFLINE, FOREGROUND job (Claude prepared, NOT run). Derived from the root r3 seeded
# run-host-registry-r1.sh (same frozen r6 closure reconstruction, provenance and schema3 checks), with ROOT r3 as the baseline:
#   adapter      root r3 adapter-generation-r2/deployment-chain-adapter.mjs b648a3ed (pinned; NOT regenerated into the tree: root's frozen
#                generator 9ee80f72 is re-run ONLY into a scratch dir to prove byte equality), then this stage's second-stage insertions
#   host files   root r3 src/network {authority 76f5be11, profile ae53da9f, dispatch 9a155041} (pinned; root's frozen host generator
#                7073e59c re-run into scratch to prove byte equality); root r3 incarnation journal 49351d80; registry profile 4816316e
#   protocol     REPO-pinned deployment-serving-permit 82494ed8 / permit-gate e198fe21 / lifecycle-witness 9859a130 + tree runtime 40333d5b
#                -> generate-host-authority-permit-candidates.mjs (insertions, restoration self-proof); REPO-pinned collector 2c2f3fc6,
#                witness-http 1e597f81 copied verbatim (they REPLACE the KVM-commit tree copies; hashes recorded in overlay.sha256)
#   new modules  deployment-host-authority.mjs, deployment-host-authority-journal.mjs (this stage)
#   one-stage    a copy of the tree whose adapter is root's b648a3ed: root's own 16-test native new-registry suite (its generator test
#                compares the ONE-stage adapter; it is root's qualified configuration, never claimed as this stage's permit binding)
#   r3 tree      a copy of root r3 src/ + test/ (its own 101 recorded checks: 8 focused + 93 host-composition) + this stage's updated
#                explicit-origin r4 control (3). The original r4 test and failure evidence are untouched and NOT run as positive controls.
# Suites (exact counts; pass == count; fail/cancelled/skipped/todo 0). ROOT VERIFY the root-r3 count against root r3's recorded run log:
#   permit-protocol 7 | permit-adapter 7 | host-registry 16 | root-r3 104 | schema3-composition 3 | root-schema3 6 | schema3-pure 3 |
#   independent-r3 5 | r5-abi 5 | r5-policy 9 | r5-proof 10            total 175
set -uo pipefail
export PATH=/usr/bin:/bin
W=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025; S=$W/lifecycle-chain-adapter-stage/r6
CL=$W/lifecycle-chain-adapter-closure-stage; R4=$W/final-consumer-composition-stage/r4
LR=/home/steven/Documents/Codex/2026-10-23/it/work/lifecycle-rollout-20261026; SRC=$LR/source-r1; DEP=$LR/dependencies-r1; RX=$LR/runtime-expiry-r1; HA=$LR/host-admission-r1
REPO=/home/steven/Documents/Codex/2026-10-23/it/work/enclave-deployment-lifecycle
NM=$REPO/node_modules
ANVIL=/home/steven/.foundry/bin/anvil
R3=$W/unified-funding-20261028/lifecycle-independent-composition-review-r3
ME=$W/unified-funding-20261028/lifecycle-schema3-adapter-review-r1
LV3=/home/steven/Documents/Codex/2026-10-23/it/work/lifecycle-ledger-v3-r1; CMP=$LV3/library-import-size-feedback/compiler
HC=$W/unified-funding-20261028/lifecycle-schema3-chain-composition-r1
HCOMP=$W/unified-funding-20261028/lifecycle-schema3-host-composition-r1
R3R=$W/unified-funding-20261028/host-registry-repair-root-review-r3
STAGE=/home/steven/Documents/Codex/2026-10-23/it/work/lifecycle-host-authority-permit-r1-20261029; ME2=$STAGE/candidate
REGR=/home/steven/Documents/Codex/2026-10-23/it/work/lifecycle-host-registry-r1-20261029
REGSRC=$REGR/candidate/contracts/EnclaveHostLifecycleRegistry.sol
REGART=$REGR/validation-result-r2/artifacts/EnclaveHostLifecycleRegistry.sol/EnclaveHostLifecycleRegistry.json
OUT=$ME2/run-permit-r1; PT=""; rc=0
die() { echo "## SETUP: $*"; echo "SETUP-FAIL $*" > "$OUT/RESULT" 2>/dev/null; echo "## host-authority-permit-r1 rc=9"; exit 9; }
SIDS=""
reap() {
  local sid=$1 left; left=$(pgrep -a -s "$sid" 2>/dev/null) || return 0
  { echo "## session $sid leftovers at $(date -u +%FT%TZ):"; echo "$left"; } >> "$OUT/cleanup.txt" 2>/dev/null
  pkill -TERM -s "$sid" 2>/dev/null; for i in 1 2 3 4 5; do pgrep -s "$sid" >/dev/null 2>&1 || return 0; sleep 1; done
  pkill -KILL -s "$sid" 2>/dev/null; return 0; }
trap 'for s in $SIDS; do reap $s; done; [ -n "$PT" ] && rm -rf --one-file-system -- "$PT"' EXIT
trap 'exit 143' TERM; trap 'exit 130' INT; trap 'exit 129' HUP
mkdir "$OUT" || exit 9
ip link set lo up 2>/dev/null; ip -o addr show lo 2>/dev/null | grep -q '127.0.0.1' || die "loopback is not up"
ip -o route 2>/dev/null | grep -v '127.0.0.0/8\|dev lo' | grep -q . && die "network route present: run under unshare -Urn"
pin() { [ "$(sha256sum < "$1" | cut -c1-64)" = "$2" ] || die "$1 is not $2"; }
python3 -I - "$STAGE/input-pins.json" <<'PY' || die "reviewed input drift (input-pins.json)"
import hashlib, json, sys
from pathlib import Path
for x, h in json.loads(Path(sys.argv[1]).read_text()).items(): assert hashlib.sha256(Path(x).read_bytes()).hexdigest() == h, x
PY
pin $STAGE/TASK.reviewed.txt 0601c3e1cca076eddc586355f01a1befa4612c5832d4be041b203d850b6ab54d
# ---- frozen r6 closure provenance: identical to run-chain-r2.sh / root r3 seeded harness ----
[ -f "$S/SHA256SUMS" ] || die "r6 is not frozen (SHA256SUMS missing)"
(cd "$S" && sha256sum -c --quiet SHA256SUMS) || die "r6 != SHA256SUMS"
pin $S/network/deployment-chain-adapter.mjs 330a908222d3a0108f83ba9d9ec0d3947b6d19a5f268360fc4b48227a4da1d30
pin $SRC/SHA256SUMS b506c43cff2246fa82598daba005ff8344de3f2f9ad1cc3a0c853f38f7eaad58; (cd $SRC && sha256sum -c --quiet SHA256SUMS) || die "source-r1 changed"
grep -q '"sourceCommit": "34a3c0d6d4c5aebffffb2492437487c9de74fb66"' $SRC/SOURCE.json || die "source-r1 is not commit 34a3c0d6"
pin $DEP/SHA256SUMS deb51211acdc35a45ee03346297fae3a242147eab47c42afb68e270196f4d9e4; (cd $DEP && sha256sum -c --quiet SHA256SUMS) || die "dependencies-r1 changed"
cmp -s $DEP/abi.json $S/abi/dependencies-r1.json || die "r6 abi/dependencies-r1.json is not KVM dependencies-r1/abi.json"
pin $RX/SHA256SUMS c0bb0ea3e0483fdc0ecad2d08327fccaa2511f8c4e352c9fb3dcf7d38c6ddf51; (cd $RX && sha256sum -c --quiet SHA256SUMS) || die "runtime-expiry-r1 changed"
grep -q '"commit": "700beed7f45c3d963897503a0c281e6fef793038"' $RX/result.json || die "runtime-expiry-r1 is not commit 700beed7"
pin $HA/SHA256SUMS 069343be4e70641ce91f79e6a1cfbe980061677ea28f2b4a95c4611962d6485a; (cd $HA && sha256sum -c --quiet SHA256SUMS) || die "host-admission-r1 changed"
grep -q '"commit": "b7dcf5af9fe8255e537dd7faa51c218448864ea2"' $HA/result.json || die "host-admission-r1 is not commit b7dcf5af9"
pin $CL/SHA256SUMS 4b9a304c8c8807aadc4d659cb3a1c0ece7962eeec290ebfc862e2003d60fce77
cmp -s $CL/lease-release-journal.mjs $S/closure-34a3/network/lease-release-journal.mjs || die "lease-release-journal differs from the root closure stage"
pin $R4/SHA256SUMS afd35070b0a9751727df307aadb01458866b9e298618461d71a7fdfb0a919a0c; pin $R4/R4-BLOBS.txt b6f3f52b5cdf87af8b51ddee7f25b428be5d533e01212182a2b37e7c0a306102
python3 -I - "$S" "$R4/R4-BLOBS.txt" "$REPO" <<'PY' || die "closure provenance check failed"
import hashlib, json, subprocess, sys
s, blobs, repo = sys.argv[1], set(open(sys.argv[2]).read().split('\n')), sys.argv[3]
g = lambda b: hashlib.sha1(b'blob %d\0' % len(b) + b).hexdigest()
for f in ('network/op-receipts-root.mjs', 'network/derived-reader/vendor/anchor-bootstrap.mjs'):
    assert f'{g(open(f"{s}/{f}", "rb").read())} {f}' in blobs, f
c = json.load(open(f'{s}/CLOSURE.json'))['closure34a3']['files']
for rel, e in c.items():
    b = open(f'{s}/closure-34a3/{rel}', 'rb').read(); assert g(b) == e['gitBlob34a3c0d6'] and hashlib.sha256(b).hexdigest() == e['sha256'], rel
    if rel == 'network/lease-release-journal.mjs': continue
    t = subprocess.run(['git', '-c', 'safe.directory=*', '-C', repo, 'ls-tree', '34a3c0d6d4c5aebffffb2492437487c9de74fb66', rel], capture_output=True, text=True).stdout.split()
    assert t[2] == e['gitBlob34a3c0d6'], rel
PY
[ -x /usr/bin/setsid ] && [ -x /usr/bin/pkill ] && [ -x /usr/bin/pgrep ] || die "setsid/pkill/pgrep missing"
pin $NM/viem/package.json e949a8d53708d253df522476d1ff2face4b05beee8099a90ed81934793455dfb
pin $ANVIL 10c1c727d6c1de973aeb160e59875b9a9a23464d6e74149ee8abb30b3500311b
pin "$CMP/bundle.json" bed9c19652edce8ca6f337f691a9909c15763e6755ff237139b07f4d84f3260e
pin $REGSRC 68310acc3bda76be0c7bf06ad5149ac1b354e3687f8268223bc8589457c071a8
pin $REGART e8690734c4fae1f1adfa3525061d5542b314704c997feec2daa09fdecd49f23a
# ---- owned tree: identical composition to the root r3 seeded harness ----
PT=$(mktemp -d /tmp/hapr1.XXXXXX) || die "mktemp"; T=$PT/r6
export ANVIL
mkdir -p $T && (cd $SRC && tar -cf - --exclude=./SHA256SUMS .) | (cd $T && tar -xf -) || die "copy source-r1"
add() { [ -e "$T/$2" ] || [ -L "$T/$2" ] && die "$2 would overwrite a frozen source file"; mkdir -p "$(dirname "$T/$2")"; cp "$1" "$T/$2" || die "copy $2"; }
put() { pin "$1" "$3"; rm -f "$T/$2"; cp "$1" "$T/$2" || die "overlay $2"; }   # an EXPLICIT reviewed replacement (hash-pinned source)
while read -r f; do add "$S/closure-34a3/$f" "$f"; done < <(cd $S/closure-34a3 && find . -type f | sed 's|^\./||' | sort)
mkdir -p $T/relay && ln -s ../net-guard.mjs $T/relay/net-guard.mjs || die "relay/net-guard.mjs symlink"
add $S/closure-b7dcf5af9/network/runtime-lock.mjs network/runtime-lock.mjs
cp $RX/network/deployment-isolation-runtime.mjs $T/network/deployment-isolation-runtime.mjs && cp $RX/test/deployment-isolation-runtime.test.mjs $T/test/deployment-isolation-runtime.test.mjs || die "compose runtime-expiry"
pin $T/network/deployment-isolation-runtime.mjs 40333d5bc08796f2881650331022746abc0b93051b48351c89f84d62a4462fd9
(cd $T && patch -p1 -s --no-backup-if-mismatch -r - < $HA/host-admission.patch) || die "KVM host-admission.patch does not apply"
for f in network/deployment-chain-adapter.mjs network/op-receipts-root.mjs network/derived-reader/vendor/anchor-bootstrap.mjs abi/dependencies-r1.json \
  abi/dependencies-34a3c0d6.json test/deployment-chain-adapter-r5-abi.test.mjs test/deployment-chain-adapter-r5-policy.test.mjs \
  test/deployment-chain-adapter-r5-proof.test.mjs test/fixtures/r5-world.mjs test/fixtures/LifecycleR5Doubles.sol; do add "$S/$f" "$f"; done
ln -s "$NM" "$T/node_modules" || die "node_modules link"
node $ME/src/tools/generate-lifecycle-schema3-adapter-candidate.mjs "$S/network/deployment-chain-adapter.mjs" "$CMP/bundle.json" "$T/network/adapter-s3-generated.mjs" \
  bed9c19652edce8ca6f337f691a9909c15763e6755ff237139b07f4d84f3260e > "$OUT/schema3-generator.json" || die "schema3 adapter generation"
add "$T/network/adapter-s3-generated.mjs" test/inputs/schema3-adapter.mjs
pin $T/test/inputs/schema3-adapter.mjs 07d02fca0fff2b4b59f7680ac0425c65b779aa61e13ae2b7205b7af4ee4443b2
rm "$T/network/adapter-s3-generated.mjs" "$T/network/deployment-chain-adapter.mjs" || die "remove r6 adapter from the owned tree"
# root r3 adapter b648a3ed: provenance proved in SCRATCH (never applied twice), then used as the second-stage input
mkdir "$PT/adapter-proof" || die "mkdir"
node $R3R/author-snapshot/src/tools/generate-lifecycle-host-registry-adapter-candidate.mjs "$T/test/inputs/schema3-adapter.mjs" "$PT/adapter-proof/deployment-chain-adapter.mjs" \
  > "$OUT/root-adapter-proof.json" || die "root adapter regeneration proof"
cmp -s "$PT/adapter-proof/deployment-chain-adapter.mjs" "$R3R/adapter-generation-r2/deployment-chain-adapter.mjs" || die "root r3 adapter b648a3ed does not reproduce"
for f in "$R3R/src/network/lifecycle-independent-admission.mjs:network/lifecycle-independent-admission.mjs" \
  "$LV3/candidate/network/lifecycle-linked-artifacts.mjs:network/lifecycle-linked-artifacts.mjs" "$ME/src/network/lifecycle-schema3-profile.mjs:network/lifecycle-schema3-profile.mjs" \
  "$CMP/bundle.json:deploy/lifecycle/schema3/bundle.json" "$R3R/author-snapshot/src/network/lifecycle-host-registry-profile.mjs:network/lifecycle-host-registry-profile.mjs" \
  "$R3R/src/network/lifecycle-host-incarnation-journal.mjs:network/lifecycle-host-incarnation-journal.mjs" \
  "$ME2/src/network/deployment-host-authority.mjs:network/deployment-host-authority.mjs" "$ME2/src/network/deployment-host-authority-journal.mjs:network/deployment-host-authority-journal.mjs" \
  "$REGART:deploy/lifecycle/host-registry/EnclaveHostLifecycleRegistry.json" "$REGSRC:deploy/lifecycle/host-registry/EnclaveHostLifecycleRegistry.sol" \
  "$R3/test/root-independent-adapter.test.mjs:test/root-independent-adapter.test.mjs" "$ME/test/root-schema3-adapter.test.mjs:test/root-schema3-adapter.test.mjs" \
  "$ME/test/schema3-pure.test.mjs:test/schema3-pure.test.mjs" "$ME/test/fixtures/schema3-world.mjs:test/fixtures/schema3-world.mjs"; do add "${f%%:*}" "${f#*:}"; done
RUNNER=$W/unified-funding-20261028/lifecycle-host-authority-review-r2/src/network/deployment-lifecycle-runner.mjs
put "$RUNNER" network/deployment-lifecycle-runner.mjs 75590c8e4be2095b9011ea3b482ceef90a1d21f92ad676dba41578093e7db668
# root r3 host files: pinned; provenance proved by root's frozen corrected generator 7073e59c into scratch (never the old 6dca generator)
mkdir "$PT/hostgen" || die "mkdir hostgen"
pin $R3R/author-snapshot/src/tools/generate-lifecycle-host-registry-host-candidate.mjs 7073e59c7560e90d22cb2fde9518c7f0ee3867f1ee7ef11f2da8d8bb1ddad64a
node $R3R/author-snapshot/src/tools/generate-lifecycle-host-registry-host-candidate.mjs "$HCOMP/src/network" "$PT/hostgen" > "$OUT/root-host-proof.json" || die "root host regeneration proof"
for f in lifecycle-host-authority.mjs:76f5be11c3e07d17e86842815e567fa327772a5aa2c12407342b3f00056ffce1 lifecycle-host-dispatch.mjs:9a155041a4a38402288bd36741fe708480e55d60675a99a731a58d13d6f84778 \
  lifecycle-host-profile.mjs:ae53da9f520e7f66e5a88c850226f96a7294708e2f5dad27c178138096f4bc94; do
  n=${f%%:*}; cmp -s "$PT/hostgen/$n" "$R3R/src/network/$n" || die "root r3 $n does not reproduce"; pin "$R3R/src/network/$n" "${f#*:}"; add "$R3R/src/network/$n" "network/$n"; done
node "$HCOMP/src/tools/generate-lifecycle-journal-candidate.mjs" "$REPO/network/deployment-lifecycle-journal.mjs" "$T/network/journal-composed.mjs" > "$OUT/journal-generator.json" || die "owned journal generation"
mv "$T/network/journal-composed.mjs" "$T/network/deployment-lifecycle-journal.mjs" || die "owned journal overlay"
add "$HCOMP/test/helpers/lifecycle-fixture.mjs" test/helpers/host-fixture.mjs
add "$HC/test/root-schema3-composition.test.mjs" test/root-schema3-composition.test.mjs
for f in generate-lifecycle-host-registry-adapter-candidate.mjs generate-lifecycle-host-registry-host-candidate.mjs; do add "$R3R/author-snapshot/src/tools/$f" "src-tools/$f"; done
add "$ME2/test/fixtures/host-registry-world.mjs" test/fixtures/host-registry-world.mjs
add "$ME2/test/root-host-registry-profile.test.mjs" test/root-host-registry-profile.test.mjs
# ---- ONE-stage copy (root's qualified configuration) for root's native 16-test suite, taken BEFORE the permit overlays ----
ONE=$PT/one; cp -a "$T" "$ONE" || die "one-stage copy"
cp "$R3R/adapter-generation-r2/deployment-chain-adapter.mjs" "$ONE/network/deployment-chain-adapter.mjs" || die "one-stage adapter"
# ---- host-authority permit r1: second-stage protocol/adapter generation (insertions, restoration self-proof) ----
mkdir "$PT/proto-base" "$PT/proto-gen" || die "mkdir proto"
cp "$REPO/network/deployment-serving-permit.mjs" "$REPO/network/deployment-permit-gate.mjs" "$REPO/network/deployment-lifecycle-witness.mjs" \
  "$T/network/deployment-isolation-runtime.mjs" "$R3R/adapter-generation-r2/deployment-chain-adapter.mjs" "$PT/proto-base/" || die "proto base"
node $ME2/src/tools/generate-host-authority-permit-candidates.mjs "$PT/proto-base" "$PT/proto-gen" > "$OUT/permit-generator.json" || die "permit generation"
for f in deployment-serving-permit.mjs deployment-permit-gate.mjs deployment-lifecycle-witness.mjs deployment-isolation-runtime.mjs deployment-chain-adapter.mjs; do
  grep -q 'host-authority permit r1' "$PT/proto-gen/$f" || die "$f lacks the marker"; rm -f "$T/network/$f"; cp "$PT/proto-gen/$f" "$T/network/$f" || die "overlay $f"; done
put "$REPO/network/deployment-permit-collector.mjs" network/deployment-permit-collector.mjs 2c2f3fc6d444300c5e15da5b54f393a72d8fb86d519c70cd7419c640a3091dba
put "$REPO/network/deployment-witness-http.mjs" network/deployment-witness-http.mjs 1e597f81b8d37c65917c3e081309294df2cf2013f9a2e3fe02d1215ef9eca10b
add "$ME2/src/tools/generate-host-authority-permit-candidates.mjs" src-tools/generate-host-authority-permit-candidates.mjs
add "$ME2/test/host-authority-permit.test.mjs" test/host-authority-permit.test.mjs
add "$ME2/test/root-host-authority-adapter.test.mjs" test/root-host-authority-adapter.test.mjs
# ---- root r3 tree (101 recorded checks) + updated explicit-origin r4 control (3) ----
R3T=$PT/r3; mkdir -p "$R3T" && cp -a "$R3R/src" "$R3R/test" "$R3T/" || die "copy root r3 tree"
cp "$ME2/test/host-generation-explicit-origin.test.mjs" "$R3T/test/" || die "explicit-origin control"
ln -s "$NM" "$R3T/node_modules" || die "r3 node_modules link"
(cd $T && sha256sum network/*.mjs deploy/lifecycle/host-registry/* test/*.mjs test/fixtures/*.mjs src-tools/*.mjs) > "$OUT/overlay.sha256"
SDIR=$T
suite() {  # name expected timeoutSec node-args... (runs in $SDIR)
  local n=$1 want=$2 lim=$3; shift 3
  setsid bash -c 'cd "$1" && lim=$2 && shift 2 && exec timeout -k 5 "$lim" node --max-old-space-size=160 --max-semi-space-size=4 --test --experimental-test-isolation=none --test-concurrency=1 --test-timeout=$(( (lim - 10) * 1000 )) --test-reporter=tap "$@"' \
    suite "$SDIR" "$lim" "$@" < /dev/null > "$OUT/$n.tap" 2>&1 &
  local sid=$!; SIDS="$SIDS $sid"
  wait $sid; local r=$?
  reap $sid; SIDS=${SIDS/ $sid/}
  python3 -I - "$OUT/$n.tap" $r $want $n <<'PY' >> "$OUT/summary.txt" || rc=1
import re, sys
t = open(sys.argv[1]).read(); rc, want, name = int(sys.argv[2]), int(sys.argv[3]), sys.argv[4]
c = {k: int(v) for k, v in re.findall(r'^# (tests|suites|pass|fail|cancelled|skipped|todo) (\d+)$', t, re.M)}
ok = rc == 0 and c.get('tests') == want and c.get('pass') == want and all(c.get(k) == 0 for k in ('fail', 'cancelled', 'skipped', 'todo'))
print(('PASS' if ok else 'FAIL') + f' {name} rc {rc} expected {want} ' + ' '.join(f'{k} {c.get(k)}' for k in ('tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo')))
sys.exit(0 if ok else 1)
PY
}
python3 $R3/precompile-test-doubles.py "$T" "$OUT" || die "exact TEST doubles precompile (r3 script, unchanged)"
python3 $R3/precompile-test-doubles.py "$ONE" "$OUT/one" || die "exact TEST doubles precompile (one-stage copy)"
suite permit-protocol 7 120 test/host-authority-permit.test.mjs
suite permit-adapter 7 420 test/root-host-authority-adapter.test.mjs
SDIR=$ONE; suite host-registry 16 420 test/root-host-registry-profile.test.mjs; SDIR=$T
SDIR=$R3T; suite root-r3 104 240 --import ./test/helpers/baseline.mjs $(cd "$R3T" && ls test/*.test.mjs); SDIR=$T
suite schema3-composition 3 120 test/root-schema3-composition.test.mjs
suite root-schema3 6 120 test/root-schema3-adapter.test.mjs
suite schema3-pure 3 40 test/schema3-pure.test.mjs
suite independent-r3 5 90 test/root-independent-adapter.test.mjs
suite r5-abi 5 60 test/deployment-chain-adapter-r5-abi.test.mjs
suite r5-policy 9 60 test/deployment-chain-adapter-r5-policy.test.mjs
suite r5-proof 10 60 test/deployment-chain-adapter-r5-proof.test.mjs
cat "$OUT/summary.txt"; { [ $rc = 0 ] && echo "PASS host-authority-permit-r1 175" || echo "FAIL host-authority-permit-r1"; } > "$OUT/RESULT"
(cd "$S" && sha256sum -c --quiet SHA256SUMS) || { echo "## FAIL: r6 stage changed during the run"; rc=1; }
echo "## outputs $OUT"; echo "## host-authority-permit-r1 rc=$rc"; exit $rc
