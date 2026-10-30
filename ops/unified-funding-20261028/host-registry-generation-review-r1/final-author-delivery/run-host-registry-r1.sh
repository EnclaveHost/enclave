#!/bin/bash
# host-registry r2: ROOT-OWNED, OFFLINE, FOREGROUND job (Claude prepared, NOT run). Derived from
# lifecycle-schema3-chain-composition-r1/run-chain-r2.sh: the SAME frozen r6 closure reconstruction, provenance checks and schema3
# overlay (lines unchanged in substance), then ONLY in the owned temporary tree:
#   network/deployment-chain-adapter.mjs  <- 07d02fca (schema3 generator output, verified) -> host-registry insertions (this candidate)
#   network/lifecycle-host-{profile,authority,dispatch}.mjs <- generated from the pinned host-composition-r1 files (insertions only)
#   network/lifecycle-host-registry-profile.mjs, deploy/lifecycle/host-registry/{.json,.sol} (input-pins e8690734 / 68310acc)
# Run (root): python3 run-host-registry-r1.py   (single CPU, unshare -Urn, RSS/floor guard, timeout)
# Suites (exact counts; pass == count; fail/cancelled/skipped/todo 0):
#   host-registry 11 | schema3-composition 3 | root-schema3 6 | schema3-pure 3 | independent-r3 5 | r5-abi 5 | r5-policy 9 | r5-proof 10
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
EMG=/home/steven/Documents/Codex/2026-10-23/it/work/lifecycle-emergency-offline-r1/candidate/contracts/EnclaveDeploymentLifecycleEmergency.sol
HC=$W/unified-funding-20261028/lifecycle-schema3-chain-composition-r1
HCOMP=$W/unified-funding-20261028/lifecycle-schema3-host-composition-r1
STAGE=/home/steven/Documents/Codex/2026-10-23/it/work/lifecycle-host-registry-profile-r2-20261029; ME2=$STAGE/candidate
REGR=/home/steven/Documents/Codex/2026-10-23/it/work/lifecycle-host-registry-r1-20261029
REGSRC=$REGR/candidate/contracts/EnclaveHostLifecycleRegistry.sol
REGART=$REGR/validation-result-r2/artifacts/EnclaveHostLifecycleRegistry.sol/EnclaveHostLifecycleRegistry.json
OUT=$STAGE/run-r1; PT=""; rc=0
die() { echo "## SETUP: $*"; echo "SETUP-FAIL $*" > "$OUT/RESULT" 2>/dev/null; echo "## host-registry-r1 rc=9"; exit 9; }
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
# ---- frozen r6 closure provenance: identical to run-chain-r2.sh ----
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
pin $SRC/network/deployment-authority-window.mjs f90d9d568c2dc820b0472639333e4655ab45a8d9b0b97aa2397347a1c7488622
pin $SRC/network/deployment-lifecycle-runner.mjs 4a52c4cb12f0dfa50dc96986415cb0b843e65dfcb02bc664a0ee4817f04ec573
pin $SRC/network/deployment-lifecycle-witness.mjs 823533116cbbc1229eb62e28dd6e0bc67cf9e41341f968eb522d2bfa65f6657d
pin $SRC/network/deployment-serving-permit.mjs 0e326d95daaba1b7d75ee3cfdc1bde73163e3353da74ca29bf70fd3a205347e3
pin $SRC/test/deployment-generation-certificate.test.mjs c3bbc6f2e34d864a737e42bb3779b91839ee8c261898d5eb50d5a28034eca98c
pin $SRC/deploy/lifecycle/AUTHORITY-ADAPTER.md 30cebc8bf48d7aa961627a807dc618bb1e98768cf7f8ce025eb1be055a120173
pin $SRC/network/deployment-isolation-runtime.mjs da809b9af528dde165c4d67dd15212f07f919a3d469ef65b35abd667705d9375
pin $SRC/test/deployment-isolation-runtime.test.mjs 312f115a7de316adb220daf2b3d234b332adc304082cef25cf26a1b0119b1545
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
t = subprocess.run(['git', '-c', 'safe.directory=*', '-C', repo, 'ls-tree', '34a3c0d6d4c5aebffffb2492437487c9de74fb66', 'relay/net-guard.mjs'], capture_output=True, text=True).stdout.split()
assert t[0] == '120000' and subprocess.run(['git', '-c', 'safe.directory=*', '-C', repo, 'cat-file', '-p', t[2]], capture_output=True, text=True).stdout == '../net-guard.mjs'
PY
pin $S/closure-b7dcf5af9/network/runtime-lock.mjs 256aeca3000aae08dc2cfa5fb45a2a900728a312d2ec415a2620588d1152ac1a
git -c safe.directory='*' -C $REPO show b7dcf5af9fe8255e537dd7faa51c218448864ea2:network/runtime-lock.mjs | cmp -s - $S/closure-b7dcf5af9/network/runtime-lock.mjs || die "runtime-lock.mjs is not KVM commit b7dcf5af9"
[ -x /usr/bin/flock ] && [ -x /usr/bin/setsid ] && [ -x /usr/bin/pkill ] && [ -x /usr/bin/pgrep ] || die "flock/setsid/pkill/pgrep missing"
pin $NM/viem/package.json e949a8d53708d253df522476d1ff2face4b05beee8099a90ed81934793455dfb
pin $NM/solc/package.json d168afdf78c7e12f14d827c16d2b26a9f05c546c4a6dd63b0b757be5053fe4fe
pin $NM/solc/soljson.js fa4345d648d9a09c6601ffc978e78e9f5267b54e6d91e8f8c473f44c0c16323b
pin $ANVIL 10c1c727d6c1de973aeb160e59875b9a9a23464d6e74149ee8abb30b3500311b
# ---- schema3 inputs (identical to run-chain-r2.sh) ----
pin $LV3/candidate/deploy/EnclaveDeployments.sol c720f1bfe021abcc4f080a5646d756c60a14cd2be8b746d995e3d1ba8b21da15
pin $LV3/candidate/deploy/EnclaveProofOfTime.sol 946f0b90db1597ee95316029f467b8c7588e962c72168e78da77d3886f72eec5
pin $EMG ac4023b9ccac9b6b48536f78f07282e8a08e6669bd983bb292bbe1ea8a8ea677
pin $REPO/contracts/EnclaveSelfHostingIdentity.sol f8dae9aba6c6ada4e92f9327fbb8801ae4bd15c645b0cea9a448a7f1bb1682e2
pin $LV3/candidate/network/lifecycle-linked-artifacts.mjs d9ad52648cf5bda505d2ccebb8a6ea49fb3bc682a7fd0d431d1f5def372808cf
pin "$CMP/bundle.json" bed9c19652edce8ca6f337f691a9909c15763e6755ff237139b07f4d84f3260e
python3 -I - "$CMP" "$OUT" <<'PY' || die "bundle does not match the retained compiler input/output"
import hashlib, json, sys
d, out = sys.argv[1], sys.argv[2]
raw = open(f'{d}/bundle.json', 'rb').read(); b = json.loads(raw)
inp = json.load(open(f'{d}/compiler-input.json')); o = json.load(open(f'{d}/compiler-output.json'))
for k, v in b['sourceSha256'].items(): assert hashlib.sha256(inp['sources'][k]['content'].encode()).hexdigest() == v, k
assert inp['settings'] == b['settings'], 'settings'
for key, a in b['contracts'].items():
    src, name = key.rsplit(':', 1); c = o['contracts'][src][name]
    assert a['creationTemplate'] == '0x' + c['evm']['bytecode']['object'] and a['runtimeTemplate'] == '0x' + c['evm']['deployedBytecode']['object'], key
    assert a['abi'] == c['abi'] and a['creationLinks'] == c['evm']['bytecode'].get('linkReferences', {}) and a['runtimeLinks'] == c['evm']['deployedBytecode'].get('linkReferences', {}), key
    assert a['immutableReferences'] == c['evm']['deployedBytecode'].get('immutableReferences', {}), key
    assert len(a['runtimeTemplate']) // 2 - 1 <= 24576, key
open(f'{out}/bundle.sha256', 'w').write(hashlib.sha256(raw).hexdigest() + '  bundle.json\n')
PY
# ---- host registry inputs: exact qualified source + r2 artifact; artifact metadata names exactly that source ----
pin $STAGE/TASK.reviewed.txt 6ac70e9156004e5a1a8ae81a106420cef8bc3daf1baa024b2eb9ea35b79d6281
pin $REGSRC 68310acc3bda76be0c7bf06ad5149ac1b354e3687f8268223bc8589457c071a8
pin $REGART e8690734c4fae1f1adfa3525061d5542b314704c997feec2daa09fdecd49f23a
python3 -I - "$REGART" "$REGSRC" "$REGR/validation-result-r2/result.json" <<'PY' || die "host registry artifact provenance"
import json, sys
a = json.load(open(sys.argv[1])); r = json.load(open(sys.argv[3])); key = sys.argv[2]
m = a['metadata']; s = m['settings']
assert m['compiler']['version'] == '0.8.35+commit.47b9dedd' and s['compilationTarget'] == {key: 'EnclaveHostLifecycleRegistry'}, 'target'
assert list(m['sources']) == [key] and s['optimizer'] == {'enabled': True, 'runs': 1} and s['viaIR'] is True and s['evmVersion'] == 'prague', 'settings'
assert a['bytecode']['linkReferences'] == {} and a['deployedBytecode']['linkReferences'] == {} and not a['deployedBytecode'].get('immutableReferences'), 'links'
assert not any(x['type'] == 'constructor' for x in a['abi']), 'constructor'
assert len(a['deployedBytecode']['object']) // 2 - 1 == 23968 and len(a['bytecode']['object']) // 2 - 1 == 23994, 'sizes'
assert r['tests'] == {'passed': 50, 'failed': 0, 'skipped': 0} and r['executableRuntimeMatchesR1'] is True and r['sourcesUnchanged'] is True, 'qualification'
PY
PT=$(mktemp -d /tmp/hr1.XXXXXX) || die "mktemp"; T=$PT/r6
export ANVIL
{ echo "node $(node --version) anvil $($ANVIL --version | head -1)"; sha256sum < "$S/SHA256SUMS"; } > "$OUT/env.txt"
mkdir -p $T && (cd $SRC && tar -cf - --exclude=./SHA256SUMS .) | (cd $T && tar -xf -) || die "copy source-r1"
add() { [ -e "$T/$2" ] || [ -L "$T/$2" ] && die "$2 would overwrite a frozen source file"; mkdir -p "$(dirname "$T/$2")"; cp "$1" "$T/$2" || die "copy $2"; }
while read -r f; do add "$S/closure-34a3/$f" "$f"; done < <(cd $S/closure-34a3 && find . -type f | sed 's|^\./||' | sort)
[ -e $T/network/host-admission-policy.mjs ] || die "closure copy failed"
mkdir -p $T/relay && ln -s ../net-guard.mjs $T/relay/net-guard.mjs || die "relay/net-guard.mjs symlink"
add $S/closure-b7dcf5af9/network/runtime-lock.mjs network/runtime-lock.mjs
cp $RX/network/deployment-isolation-runtime.mjs $T/network/deployment-isolation-runtime.mjs && cp $RX/test/deployment-isolation-runtime.test.mjs $T/test/deployment-isolation-runtime.test.mjs || die "compose runtime-expiry"
pin $T/network/deployment-isolation-runtime.mjs 40333d5bc08796f2881650331022746abc0b93051b48351c89f84d62a4462fd9
(cd $T && patch -p1 -s --no-backup-if-mismatch -r - < $HA/host-admission.patch) || die "KVM host-admission.patch does not apply to source-r1 + runtime-expiry"
for f in deploy/lifecycle/AUTHORITY-ADAPTER.md network/deployment-authority-window.mjs network/deployment-lifecycle-runner.mjs network/deployment-lifecycle-witness.mjs \
  network/deployment-serving-permit.mjs test/deployment-generation-certificate.test.mjs; do cmp -s $T/$f $HA/$f || die "patched $f differs from the delivered host-admission-r1 file"; done
for f in deploy/lifecycle/AUTHORITY-ADAPTER.md network/deployment-authority-window.mjs network/deployment-isolation-runtime.mjs network/deployment-lifecycle-runner.mjs \
  network/deployment-lifecycle-witness.mjs network/deployment-serving-permit.mjs test/deployment-generation-certificate.test.mjs test/deployment-isolation-runtime.test.mjs; do
  git -c safe.directory='*' -C $REPO show b7dcf5af9fe8255e537dd7faa51c218448864ea2:$f | cmp -s - $T/$f || die "composed $f is not KVM commit b7dcf5af9"; done
for f in network/deployment-chain-adapter.mjs network/op-receipts-root.mjs network/derived-reader/vendor/anchor-bootstrap.mjs abi/dependencies-r1.json \
  abi/dependencies-34a3c0d6.json test/deployment-chain-adapter-r5-abi.test.mjs test/deployment-chain-adapter-r5-policy.test.mjs \
  test/deployment-chain-adapter-r5-proof.test.mjs test/fixtures/r5-world.mjs test/fixtures/LifecycleR5Doubles.sol; do add "$S/$f" "$f"; done
ln -s "$NM" "$T/node_modules" || die "node_modules link"
# ---- schema3 r1 overlay (identical), then the qualified 07d02fca is kept as the host-registry generator input ----
node $ME/src/tools/generate-lifecycle-schema3-adapter-candidate.mjs "$S/network/deployment-chain-adapter.mjs" "$CMP/bundle.json" "$T/network/adapter-s3-generated.mjs" \
  "$(cut -c1-64 "$OUT/bundle.sha256")" > "$OUT/generator.json" || die "schema3 adapter generation"
add "$T/network/adapter-s3-generated.mjs" test/inputs/schema3-adapter.mjs
pin $T/test/inputs/schema3-adapter.mjs 07d02fca0fff2b4b59f7680ac0425c65b779aa61e13ae2b7205b7af4ee4443b2
rm "$T/network/adapter-s3-generated.mjs" && rm "$T/network/deployment-chain-adapter.mjs" || die "remove r6 adapter from the owned tree"
node $ME2/src/tools/generate-lifecycle-host-registry-adapter-candidate.mjs "$T/test/inputs/schema3-adapter.mjs" "$T/network/deployment-chain-adapter.mjs" \
  > "$OUT/hr-adapter-generator.json" || die "host-registry adapter generation"
add $R3/src/network/lifecycle-independent-admission.mjs network/lifecycle-independent-admission.mjs
add $LV3/candidate/network/lifecycle-linked-artifacts.mjs network/lifecycle-linked-artifacts.mjs
add $ME/src/network/lifecycle-schema3-profile.mjs network/lifecycle-schema3-profile.mjs
add $CMP/bundle.json deploy/lifecycle/schema3/bundle.json
add $ME2/src/network/lifecycle-host-registry-profile.mjs network/lifecycle-host-registry-profile.mjs
add $REGART deploy/lifecycle/host-registry/EnclaveHostLifecycleRegistry.json
add $REGSRC deploy/lifecycle/host-registry/EnclaveHostLifecycleRegistry.sol
add $R3/test/root-independent-adapter.test.mjs test/root-independent-adapter.test.mjs
add $ME/test/root-schema3-adapter.test.mjs test/root-schema3-adapter.test.mjs
add $ME/test/schema3-pure.test.mjs test/schema3-pure.test.mjs
add $ME/test/fixtures/schema3-world.mjs test/fixtures/schema3-world.mjs
RUNNER=$W/unified-funding-20261028/lifecycle-host-authority-review-r2/src/network/deployment-lifecycle-runner.mjs
pin "$RUNNER" 75590c8e4be2095b9011ea3b482ceef90a1d21f92ad676dba41578093e7db668
cp "$RUNNER" "$T/network/deployment-lifecycle-runner.mjs" || die "root-fixed runner overlay"
python3 -I - "$HCOMP" "$HC" <<'PINS' || die "host composition inputs changed"
import hashlib,json,sys
from pathlib import Path
for root,name in [(Path(sys.argv[1]),'review-pins.json'),(Path(sys.argv[2]),'input-r2.json')]:
 for rel,h in json.loads((root/name).read_text()).items():
  assert hashlib.sha256((root/rel).read_bytes()).hexdigest()==h,rel
PINS
mkdir "$PT/hostgen" || die "mkdir hostgen"
node $ME2/src/tools/generate-lifecycle-host-registry-host-candidate.mjs "$HCOMP/src/network" "$PT/hostgen" > "$OUT/hr-host-generator.json" || die "host file generation"
for f in lifecycle-host-authority.mjs lifecycle-host-dispatch.mjs lifecycle-host-profile.mjs; do add "$PT/hostgen/$f" "network/$f"; done
node "$HCOMP/src/tools/generate-lifecycle-journal-candidate.mjs" "$REPO/network/deployment-lifecycle-journal.mjs" "$T/network/journal-composed.mjs" > "$OUT/journal-generator.json" || die "owned journal generation"
mv "$T/network/journal-composed.mjs" "$T/network/deployment-lifecycle-journal.mjs" || die "owned journal overlay"
add "$HCOMP/test/helpers/lifecycle-fixture.mjs" test/helpers/host-fixture.mjs
add "$HC/test/root-schema3-composition.test.mjs" test/root-schema3-composition.test.mjs
for f in generate-lifecycle-host-registry-adapter-candidate.mjs generate-lifecycle-host-registry-host-candidate.mjs; do add "$ME2/src/tools/$f" "src-tools/$f"; done
add "$ME2/test/fixtures/host-registry-world.mjs" test/fixtures/host-registry-world.mjs
add "$ME2/test/root-host-registry-profile.test.mjs" test/root-host-registry-profile.test.mjs
(cd $T && sha256sum network/deployment-chain-adapter.mjs network/lifecycle-host-*.mjs network/lifecycle-host-registry-profile.mjs network/lifecycle-schema3-profile.mjs \
  deploy/lifecycle/host-registry/* deploy/lifecycle/schema3/bundle.json test/inputs/schema3-adapter.mjs test/fixtures/host-registry-world.mjs \
  test/root-host-registry-profile.test.mjs src-tools/*.mjs) > "$OUT/overlay.sha256"
suite() {  # name expected timeoutSec tests...
  local n=$1 want=$2 lim=$3; shift 3
  setsid bash -c 'cd "$1" && lim=$2 && shift 2 && exec timeout -k 5 "$lim" node --max-old-space-size=160 --max-semi-space-size=4 --test --experimental-test-isolation=none --test-concurrency=1 --test-timeout=$(( (lim - 10) * 1000 )) --test-reporter=tap "$@"' \
    suite "$T" "$lim" "$@" < /dev/null > "$OUT/$n.tap" 2>&1 &
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
suite host-registry 11 420 test/root-host-registry-profile.test.mjs
suite schema3-composition 3 180 test/root-schema3-composition.test.mjs
suite root-schema3 6 180 test/root-schema3-adapter.test.mjs
suite schema3-pure 3 60 test/schema3-pure.test.mjs
suite independent-r3 5 150 test/root-independent-adapter.test.mjs
suite r5-abi 5 120 test/deployment-chain-adapter-r5-abi.test.mjs
suite r5-policy 9 120 test/deployment-chain-adapter-r5-policy.test.mjs
suite r5-proof 10 120 test/deployment-chain-adapter-r5-proof.test.mjs
cat "$OUT/summary.txt"; { [ $rc = 0 ] && echo "PASS host-registry-r1 52" || echo "FAIL host-registry-r1"; } > "$OUT/RESULT"
(cd "$S" && sha256sum -c --quiet SHA256SUMS) || { echo "## FAIL: r6 stage changed during the run"; rc=1; }
pin $REGSRC 68310acc3bda76be0c7bf06ad5149ac1b354e3687f8268223bc8589457c071a8; pin $REGART e8690734c4fae1f1adfa3525061d5542b314704c997feec2daa09fdecd49f23a
echo "## outputs $OUT"; echo "## host-registry-r1 rc=$rc"; exit $rc
