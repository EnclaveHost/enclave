#!/bin/bash
# writer-cold-recovery-stage/r4: ROOT job (prepared by Claude, NOT run by Claude). r4 = frozen r3 (320b80b8, tree a4dd62c3) + patches/
# writer-cold-recovery-r4-vs-r3.patch (review 1592 M1/M2/L1: per-method boundedRpc byte caps, one scan-wide call/byte budget, batch
# abort + settle before rejection, committed-only cache statistics) = tree 571b5c84. r3: frozen r2 (73fae0c1) + the r3 patch
# (review 1569 F1/F3/F5/F6, F2/F4 bounded concurrency + RAM resume + yields; root 1571 cache bound). Unchanged r2 description follows.
# Cold recovery of lease claims older than a start's
# ASR bootstrap anchor N (root decision 1554/1556, §Alt): the AUTHENTICATED BACKWARD header + receipt scan from N down to the ledger
# floor inclusive (network/derived-reader/backward-history.mjs: anchor-bootstrap headerHash parent links, logsBloom skip only on
# exclusion, op-receipts-root verifyBlockReceipts with raw-transaction transactionsRoot binding), joined exactly to the runtime
# coverage (N, anchor]; readLeaseHistory + relay writer integration. Base: the frozen writer-two-anchor r3 (5f141c3f) + patches/
# writer-cold-recovery-r2-vs-two-anchor-r3.patch = source tree e903c224. Changes KVM-owned network/ files (root coordinates with KVM).
# Scope: FIXTURES (52 REAL Base mainnet headers for the walk and blooms; a synthetic canonical chain for receipts). NOTHING measures the
# scan's own-node cost (N - 52,515,705 headers), whether the own node serves eth_getBlockReceipts / debug_getRawTransactions, native
# time or S age (M1-M6). No driver here (separate agent). Writer authority stays refused in production (no image template enables
# the history or provisional policy). TEST DISCOVERY is explicit (every suite named; counts exact). ENVIRONMENT: never sets or exports
# HOME, CODEX_HOME, TMPDIR or TEST_TMP; scratch is $OUT; tests use the system temporary directory, which they clean.
# Modes (private user/net/mount namespace; bounded, sequential; nothing outside $OUT is written):
#   slice (512 MiB, NO build): backward-history 16, writer-history 9, the two-anchor suites (13, 12, 12), KVM r3's six suites, writer 23,
#     composition 6, replica 8, enrollment 19 - from SOURCE. NOT a release, bundle, image or authority qualification.
#   check (2560 MiB): the two-anchor r3 check set (strict build, reader pin, guest bundle, relay set, startups) + the two new suites.
#   cd /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025
#   bash jobs/q-exit-status.sh wcr-r4-slice  512 unshare -Urnm bash writer-cold-recovery-stage/r4/jobs/root-writer-cold-recovery-r4.sh slice
#   bash jobs/q-exit-status.sh wcr-r4-check 2560 unshare -Urnm bash writer-cold-recovery-stage/r4/jobs/root-writer-cold-recovery-r4.sh check
set -uo pipefail
MODE=${1:-}; shift || true
case "$MODE" in check|slice) ;; *) echo "usage: $0 check | slice"; exit 2;; esac
ip link set lo up 2>/dev/null || true
P=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025
S=$P/writer-cold-recovery-stage/r4; CR3=$P/writer-cold-recovery-stage/r3; CR3_SUMS=320b80b8cadaeaa622717da96522d64460ea1dee0d5372e793fb525088ac280e; CR3_TREE=a4dd62c303e2742dadc2b5fdf9d6d0023e5cd91a; CR2=$P/writer-cold-recovery-stage/r2; CR2_SUMS=73fae0c1046083bfbea8014e27efc33aa1b7788f664191962e20c3b59cc22f50; CR2_TREE=e903c224163a47186b96e7f94e5094c5a043c3b2; W3=$P/writer-two-anchor-stage/r3; W2=$P/writer-two-anchor-stage/r2; W1=$P/writer-two-anchor-stage/r1; R9=$P/accepted-image-enrollment-stage/r9; R9RUN=$R9/runs/20261026T165416Z-check-2058632
R3=$P/accepted-image-assets-stage/r3
R9_SUMS=528ff8e8b91c5e563c640c7aed77d6662e82331c7923cfbe916514adbc08b2ec
BASE_COMMIT=296a583331b638a430f72929648ebf26d86522d3; BASE_TREE=90e4cdaada85825f15bccc8bf9df07bf418da9bf; BASE_SRC_TREE=68245755168b13bb47041bce54ad5fb7cd0b89da
W1_SUMS=cdacd616e3b217d6450c768b1a2cc520d6000aee719cddd064502297a37ae0b9; W1_TREE=f22d554c04f959a56d993f1c5048cd9e06a2d4b0
W2_SUMS=3dba09e6700a4a8d6cbfb00b6ee70630b1318e5e3822a537d5e3e585e2922fe2; W2_TREE=20d0d76a98da84622b98991547dc07fb2fe39e3e
W3_SUMS=5ca6754e1117ee442e00ee1854db1f814fafdf58dd2fc72c38e36cd91abe0f7a; W3_TREE=5f141c3fa476b904d6a0107a75c31c9113726591
NEW_TREE=571b5c84a8ffe3e6bc9c21ca4184a5b4a7ebb1af
PATCH1=$W1/patches/writer-two-anchor-r1-vs-r9-release.patch; PATCH2=$W2/patches/writer-two-anchor-r2-vs-r1.patch; PATCH3=$W3/patches/writer-two-anchor-r3-vs-r2.patch; PATCH4=$CR2/patches/writer-cold-recovery-r2-vs-two-anchor-r3.patch; PATCH5=$CR3/patches/writer-cold-recovery-r3-vs-r2.patch; PATCH6=$S/patches/writer-cold-recovery-r4-vs-r3.patch
T=$P/rpc-final-candidate-20261026/tree; HEAD=64156dcd91ff1e769e74f9c26a846be19254c716
LOCK=9ada1611f431d9cc804af46bea54a5aca9e92b44bee40000ee7e995e25d69f20; RUNTIME_PIN=e12c5bafb8b17abb891fb26fe1cdc054159d7bd2de5486d2c1a2480430671ed6
SCHED_PIN=694f1297286ff2ecf6d1b0e6b37153203963f7893eb2607f7d53c2f03f2eea0c        # r1 reviewed provisional mode (r9: 688b7a1f09c8...); unchanged in r2
KVM_R3=/home/steven/Documents/Codex/2026-10-23/it/work/lifecycle-rollout-20261026/journal-durability-r3
KVM_R3_SUMS=14656ef532c9d73539205e873421da8131e5f9c382cf2b6116621d72feae717d
READER_IN=$P/accepted-image-assets-stage/runs/run-20261026T135941Z-assets-1865301/inputs
CV_IN=$P/canonical-integration-actual/run/regress-20261026T005955Z/chain-verifier-inputs
BUDGET=${WCR_R2_BUDGET_SEC:-7200}
OUT=$S/runs/$(date -u +%Y%m%dT%H%M%SZ)-$MODE-$$; L=$OUT/logs; export GIT_OPTIONAL_LOCKS=0
die() { echo "## INVALID: $*" | tee -a $OUT/setup.txt; echo "## writer-cold-recovery-r4 $MODE rc=9"; exit 9; }
[ ! -e "$OUT" ] && mkdir -p $L $OUT/tmp || { echo "output dir"; exit 9; }
ip -o route 2>/dev/null | grep -q . && die "network route present: run under unshare -Urnm"
mount --make-rprivate / 2>/dev/null || die "no private mount namespace: run under unshare -Urnm"
# 0. frozen inputs: this stage, the r9 stage + its qualified check run, the KVM r3 closure (counts only)
(cd $S && sha256sum -c --quiet SHA256SUMS) || die "cold-recovery r4 stage != SHA256SUMS"
[ "$(sha256sum < $CR3/SHA256SUMS | cut -c1-64)" = $CR3_SUMS ] && (cd $CR3 && sha256sum -c --quiet SHA256SUMS) || die "the frozen cold-recovery r3 stage changed"
[ "$(sha256sum < $CR2/SHA256SUMS | cut -c1-64)" = $CR2_SUMS ] && (cd $CR2 && sha256sum -c --quiet SHA256SUMS) || die "the frozen cold-recovery r2 stage changed"
[ "$(sha256sum < $W3/SHA256SUMS | cut -c1-64)" = $W3_SUMS ] && (cd $W3 && sha256sum -c --quiet SHA256SUMS) || die "the frozen two-anchor r3 stage changed"
[ "$(sha256sum < $W2/SHA256SUMS | cut -c1-64)" = $W2_SUMS ] && (cd $W2 && sha256sum -c --quiet SHA256SUMS) || die "the frozen r2 stage changed"
[ "$(sha256sum < $W1/SHA256SUMS | cut -c1-64)" = $W1_SUMS ] && (cd $W1 && sha256sum -c --quiet SHA256SUMS) || die "the frozen r1 stage changed"
[ "$(sha256sum < $R9/SHA256SUMS | cut -c1-64)" = $R9_SUMS ] && (cd $R9 && sha256sum -c --quiet SHA256SUMS) || die "r9 stage changed"
python3 -I -c 'import json,sys; v=json.load(open(sys.argv[1])); r=v["release"]; assert v["ok"] is True and v["mode"] == "check" and r["commit"] == sys.argv[2] and r["tree"] == sys.argv[3] and r["sourceTree"] == sys.argv[4]' \
  $R9RUN/verdict.json $BASE_COMMIT $BASE_TREE $BASE_SRC_TREE || die "the r9 run is not the qualified check verdict for $BASE_COMMIT"
[ "$(cat $R9RUN/stage-sums.sha256)" = $R9_SUMS ] || die "the r9 run was made by other r9 stage bytes"
[ "$(sha256sum < $KVM_R3/SHA256SUMS | cut -c1-64)" = $KVM_R3_SUMS ] && (cd $KVM_R3 && sha256sum -c --quiet SHA256SUMS) && [ -f $KVM_R3/expected-counts.json ] || die "KVM r3 closure changed"
sha256sum < $S/SHA256SUMS | cut -c1-64 > $OUT/stage-sums.sha256
bindro() { local src=$1 dst=$2; [ -d "$src" ] || return 0; mkdir -p $dst && mount --bind "$src" $dst && mount -o remount,bind,ro $dst || die "bind $src"; }
cleanup() { for d in relay/node_modules network/node_modules node_modules; do umount $OUT/repo/$d 2>/dev/null || true; done; }
trap cleanup EXIT
export PATH=/home/steven/.foundry/bin:/usr/bin:/bin FOUNDRY_OFFLINE=true

# 1. compose: the r9 RELEASE commit (source + its generated files) + the frozen r1 patch (= W1_TREE) + the frozen r2 patch (= W2_TREE) + the r3 patch = NEW_TREE
REPO=$OUT/repo
git clone -q --no-hardlinks $R9RUN/release.git $REPO && git -C $REPO checkout -q $BASE_COMMIT || die "r9 release checkout"
[ "$(git -C $REPO rev-parse HEAD^{tree})" = $BASE_TREE ] || die "r9 release tree"
(cd $REPO && git apply --index $PATCH1 && git add -f -A && [ "$(git write-tree)" = $W1_TREE ] \
  && git apply --index $PATCH2 && git add -f -A && [ "$(git write-tree)" = $W2_TREE ] \
  && git apply --index $PATCH3 && git add -f -A && [ "$(git write-tree)" = $W3_TREE ] \
  && git apply --index $PATCH4 && git add -f -A && [ "$(git write-tree)" = $CR2_TREE ] \
  && git apply --index $PATCH5 && git add -f -A && [ "$(git write-tree)" = $CR3_TREE ] \
  && git apply --index $PATCH6 && git add -f -A && [ "$(git write-tree)" = $NEW_TREE ] \
  && git -c user.name=root -c user.email=root@localhost commit -qm "writer-cold-recovery r4 (source; r3 + review-1592 bounds) on two-anchor r3 $W3_TREE on r9 release $BASE_COMMIT") > $L/compose.txt 2>&1 || die "composed tree is not $W1_TREE / $W2_TREE / $W3_TREE / $CR2_TREE / $CR3_TREE / $NEW_TREE"
SRC_COMMIT=$(git -C $REPO rev-parse HEAD)
[ "$(sha256sum < $REPO/network/derived-reader/vendor/schedule_reader.mjs | cut -c1-64)" = $SCHED_PIN ] || die "vendored schedule reader != $SCHED_PIN"
python3 -I - $REPO/metal/derived-reader-image.json $READER_IN <<'PY' > $L/reader-inputs.json || die "a reader input is not the pinned file"
import hashlib, json, os, sys
p, d = json.load(open(sys.argv[1])), sys.argv[2]
want = {os.path.basename(v["path"]): v["sha256"] for v in [*p["binaries"].values(), *p["files"].values()]}; want.update(p["glibcRuntime"]["files"])
got = {n: hashlib.sha256(open(os.path.join(d, n), "rb").read()).hexdigest() for n in want}
bad = {n: h for n, h in got.items() if h != want[n]}; print(json.dumps({"inputs": sorted(want), "mismatch": bad})); sys.exit(1 if bad else 0)
PY
# 2. the qualified dependency tree and tools; node_modules bound READ-ONLY (locks equal)
[ "$(git -C $T rev-parse HEAD)" = $HEAD ] && [ -z "$(git -C $T status --porcelain --untracked-files=no)" ] || die "candidate checkout is not a clean 64156dcd"
[ "$(sha256sum < $T/package-lock.json | cut -c1-64)" = $LOCK ] && grep -q '"version": "2.53.1"' $T/node_modules/viem/package.json || die "node_modules identity"
[ "$(sha256sum < "$(command -v anvil)" | cut -c1-64)" = 10c1c727d6c1de973aeb160e59875b9a9a23464d6e74149ee8abb30b3500311b ] || die "anvil is not the pinned one"
for d in . network relay; do cmp -s $T/$d/package-lock.json $REPO/$d/package-lock.json 2>/dev/null || [ ! -e $T/$d/package-lock.json ] || die "$d lock != the dependency tree's lock"
  bindro "$(readlink -f $T/$d/node_modules)" $REPO/$d/node_modules; done
(cd $REPO && env -i PATH=$PATH node --input-type=module -e "
  import { readCheckpoint } from './network/derived-reader/l1-runtime.mjs';
  const c = readCheckpoint('$READER_IN/checkpoint.json'); console.log(JSON.stringify({ checkpoint: c.digest, slot: c.slot,
    expiresUtc: new Date((c.timestamp + 604800) * 1000).toISOString() }));") > $L/checkpoint.json 2>&1 || die "KVM's readCheckpoint refuses the checkpoint (expired after 2026-11-01T19:21:59Z, or not reviewed)"
# the writer suites' two ABIs, exactly as r9's integration step
git -C $REPO ls-files contracts/foundry/out | grep -q . && die "contracts/foundry/out is tracked"
for c in EnclaveDeployments EnclaveAddressBook; do mkdir -p $REPO/contracts/foundry/out/$c.sol && cp $T/contracts/foundry/out/$c.sol/$c.json $REPO/contracts/foundry/out/$c.sol/ || die "abi $c"; done
step() { [ $SECONDS -lt $BUDGET ] || die "run budget ${BUDGET}s exhausted before $1"; }
run() { local n=$1 lim=$2; shift 2; step $n
  (cd $REPO && env -i PATH=$PATH FOUNDRY_OFFLINE=true ${NODE_OPTS:+NODE_OPTIONS=$NODE_OPTS} ${KVM:+KVM_TREE=$REPO} DERIVED_READER_INPUTS=$READER_IN AIE_ROLE_LOG_DIR=$L \
     timeout -k 10 $lim node --test --test-reporter=tap --test-concurrency=1 --test-timeout=600000 "$@" < /dev/null) > $L/$n.tap 2>&1; echo $? > $L/$n.rc; }
python3 -I -c 'import json,sys; [print(k) for k in json.load(open(sys.argv[1]))]' $KVM_R3/expected-counts.json > $L/kvm-files.txt
# 3. the source suites (both modes): the two new suites first, then every changed module's existing suites at their r9 counts
NODE_OPTS=--max-old-space-size=384 KVM=
run two-anchor-reader 900 test/derived-reader/two-anchor.test.mjs
run two-anchor-reader-r2 900 test/derived-reader/two-anchor-r2.test.mjs
run two-anchor-writer 300 test/derived-writer-two-anchor.test.mjs
run backward-history 900 test/derived-reader/backward-history.test.mjs
run writer-history 300 test/derived-writer-history.test.mjs
while read -r kf; do run "kvm--$(echo $kf | tr / _)" 900 $kf; done < $L/kvm-files.txt
KVM=1 run writer 900 test/derived-writer-authority.test.mjs test/derived-writer-authority-abi.test.mjs test/derived-writer-authority-kvm-store.test.mjs
KVM=
run composition 1200 test/derived-state-kvm-composition.test.mjs
run replica-exact 300 test/state-replica-exact.test.mjs
run enrollment 900 test/derived-state-enrollment.test.mjs
if [ $MODE = check ]; then
  # 4. release prerequisites in the r9 order: shared runtime (pinned, unchanged), reader runtime + the NEW reader pin, guest bundle regenerated
  step build-network; (cd $REPO && timeout -k 10 600 node relay/build-network.mjs < /dev/null) > $L/build-network.out 2>&1 || die "build-network"
  RT=$(sha256sum < $REPO/relay/network-runtime.bundle.mjs | cut -c1-64); echo $RT > $L/network-runtime.sha256
  [ $RT = $RUNTIME_PIN ] || die "shared relay runtime $RT != pin $RUNTIME_PIN"
  step build-derived-reader-runtime; (cd $REPO/relay && timeout -k 10 600 node build-derived-reader-runtime.mjs < /dev/null) > $L/build-derived-reader-runtime.out 2>&1 || die "build-derived-reader-runtime"
  [ "$(sha256sum < $REPO/relay/schedule_reader.mjs | cut -c1-64)" = $SCHED_PIN ] || die "relay/schedule_reader.mjs != the new pin"
  step platform-api; (cd $REPO && timeout -k 10 900 node scripts/build-platform-api-guest-bundle.mjs --check < /dev/null) > $L/platform-api-check--before.out 2>&1; echo $? > $L/platform-api-check--before.rc
  (cd $REPO && timeout -k 10 900 node scripts/build-platform-api-guest-bundle.mjs < /dev/null) > $L/platform-api-regenerate.out 2>&1 || die "platform-api regeneration"
  (cd $REPO && timeout -k 10 900 node scripts/build-platform-api-guest-bundle.mjs --check < /dev/null) > $L/platform-api-check--after.out 2>&1; echo $? > $L/platform-api-check--after.rc
  [ "$(cat $L/platform-api-check--after.rc)" = 0 ] || die "platform-api --check after regeneration"
  python3 -I - $REPO $SCHED_PIN <<'PY' > $L/bundle.json || die "the regenerated bundle does not carry the edited adapter or the new sidecars"
import hashlib, json, sys, pathlib
r, pin = pathlib.Path(sys.argv[1]), sys.argv[2]; h = lambda p: hashlib.sha256((r / p).read_bytes()).hexdigest()
m = json.loads((r / "metal/guest/platform-api.bundle.mjs.manifest.json").read_text())
ok = m["sha256"] == h("metal/guest/platform-api.bundle.mjs") and all(m["inputs"].get(f) == h(f) for f in ("relay/derived-writer-authority.mjs", "relay/api-relay.js")) \
  and all(m["sidecars"][b]["sha256"] == h(s) for b, s in (("derived-reader-runtime.bundle.mjs", "relay/derived-reader-runtime.bundle.mjs"), ("schedule_reader.mjs", "relay/schedule_reader.mjs"))) \
  and m["sidecars"]["schedule_reader.mjs"]["sha256"] == pin
print(json.dumps({"ok": ok, "sha256": m["sha256"], "bytes": m["bytes"], "inputs": len(m["inputs"]), "sidecars": {k: v["sha256"] for k, v in m["sidecars"].items()}})); sys.exit(0 if ok else 1)
PY
  # 5. the private RELEASE commit: the source commit + only (a subset of) the generated files; a changed reader makes its bundle,
  # manifest and sidecar change, so - unlike r9 - those are EXPECTED to differ here
  GEN="metal/guest/platform-api.bundle.mjs metal/guest/platform-api.bundle.mjs.manifest.json relay/derived-reader-runtime.bundle.mjs relay/derived-reader-runtime.bundle.mjs.manifest.json relay/schedule_reader.mjs relay/network-runtime.bundle.mjs relay/network-runtime.bundle.mjs.manifest.json"
  CHANGED=$(git -C $REPO diff --name-only | LC_ALL=C sort)
  for c in $CHANGED; do case " $GEN " in *" $c "*) ;; *) die "the builds changed a non-generated tracked file: $c";; esac; done
  echo "$CHANGED" > $L/generated-changed.txt
  (cd $REPO && git add -f -- $GEN && git -c user.name=root -c user.email=root@localhost commit -qm "writer-cold-recovery r4 release (generated files)") || die "release commit"
  REL_COMMIT=$(git -C $REPO rev-parse HEAD); REL_TREE=$(git -C $REPO rev-parse HEAD^{tree})
  git clone -q --bare --no-hardlinks $REPO $OUT/release.git || die "preserve release"
  (cd $REPO && sha256sum $GEN) > $OUT/RELEASE.sha256
  (cd $REPO && env -i PATH=$PATH node --input-type=module -e "
    const rt = await import('./relay/derived-reader-runtime.bundle.mjs'); const { declaresDerivedStateApi } = await import('./relay/derived-writer-authority.mjs');
    const ok = declaresDerivedStateApi(rt); console.log(JSON.stringify({ declared: ok, api: rt.DERIVED_STATE_API ?? null })); process.exit(ok ? 0 : 1);") > $L/kvm-declaration.json 2>&1 \
    || die "the BUILT derived reader runtime does not declare the exact durable-state API"
  # 6. the r9 check set (unchanged suites at r9's counts) + the built-artifact suites
  if [ -f $REPO/test/deployment-journal-native.mjs ]; then
    step kvm-native; (cd $REPO && env -i PATH=$PATH timeout -k 5 60 node --max-old-space-size=64 test/deployment-journal-native.mjs < /dev/null) > $L/kvm-native.txt 2>&1; echo $? > $L/kvm-native.rc
  else echo 9 > $L/kvm-native.rc; echo "no native owner check" > $L/kvm-native.txt; fi
  run endpoints 600 test/derived-reader-endpoints.test.mjs
  step overlay; (cd $REPO && env -i PATH=$PATH PYTHONDONTWRITEBYTECODE=1 DERIVED_READER_INPUTS=$READER_IN CHAIN_VERIFIER_INPUTS=$CV_IN \
    timeout -k 5 1200 python3 -I test/metal-control-overlay.test.py -v) > $L/overlay.txt 2>&1; echo $? > $L/overlay.rc
  run platform-api-config 900 test/platform-api-config.test.mjs
  run relay-derived-reader-runtime 900 test/relay-derived-reader-runtime.test.mjs
  NODE_OPTS=
  run paid-derived-packaging 1200 test/paid-derived-packaging.test.mjs
  # the actual relay startups (r9): three writer refusals, the role-composed unenrolled refusal, the no-downgrade marker
  BOOK=ADDRESS_BOOK_ADDRESS=0x7777777777777777777777777777777777777777
  startup() { local name=$1 want=$2; shift 2
    (cd $REPO/relay && env -i PATH=$PATH API_RELAY_PORT=0 $BOOK "$@" timeout -k 5 90 node api-relay.js) > $L/startup-$name.txt 2>&1; local rc=$?
    if [ $rc = 1 ] && grep -q "fatal: writer authority: .*$want" $L/startup-$name.txt; then echo "startup $name: OK"; else echo "startup $name: FAIL (rc $rc)"; fi; }
  step startup
  UR=$OUT/tmp/unenrolled-role
  (cd $REPO && env -i PATH=$PATH node $R3/jobs/unenrolled-startup-config.mjs $REPO $READER_IN $UR) > $L/unenrolled-compose.json 2> $L/unenrolled-compose.err || die "role composition for the startup case"
  DENV=$(python3 -I -c 'import json,sys; e=json.load(open(sys.argv[1]))["env"]; print(" ".join(f"{k}={v}" for k,v in sorted(e.items())))' $L/unenrolled-compose.json)
  { startup no-verifier "needs the relay's verifier authority" ENCLAVE_WRITER_AUTHORITY_SOURCE=derived ENCLAVE_DERIVED_READER_CONFIG=/nonexistent/r.json ENCLAVE_DERIVED_ANCHOR_JOURNAL=/nonexistent/j.json
    startup bad-value 'must be "derived" or unset' ENCLAVE_WRITER_AUTHORITY_SOURCE=quorum
    startup url-config "absolute file path" ENCLAVE_CHAIN_AUTHORITY=verifier ENCLAVE_CHAIN_VERIFIER=http://127.0.0.1:9 ENCLAVE_WRITER_AUTHORITY_SOURCE=derived ENCLAVE_DERIVED_READER_CONFIG=http://127.0.0.1:9/reader ENCLAVE_DERIVED_ANCHOR_JOURNAL=/nonexistent/j.json
    startup unenrolled "explicit enrollment/recovery required" ENCLAVE_CHAIN_AUTHORITY=verifier ENCLAVE_CHAIN_VERIFIER=http://127.0.0.1:9 $DENV
    (cd $REPO/relay && env -i PATH=$PATH API_RELAY_PORT=0 $BOOK ENCLAVE_DERIVED_INTENDED=1 timeout -k 5 20 node api-relay.js) > $L/startup-intended.txt 2>&1; irc=$?
    if [ $irc = 124 ] && grep -q "writer authority REFUSED: the role intended the derived reader" $L/startup-intended.txt && ! grep -q "^fatal:" $L/startup-intended.txt; then echo "startup intended: OK"; else echo "startup intended: FAIL (rc $irc)"; fi; } > $L/startup.txt
  python3 -I $R9/jobs/check-unenrolled-tree.py --self-test > $L/unenrolled-checker-selftest.json 2>&1; echo $? > $L/unenrolled-checker-selftest.rc
  python3 -I $R9/jobs/check-unenrolled-tree.py $UR > $L/unenrolled-tree.json 2>&1; echo $? > $L/unenrolled-tree.rc
  # relay inputs exactly as r9's relay mode: the reviewed artifact set (replacing the two integration ABIs)
  OT=$P/offchain-registration-fixture-stage/runs/20261026T040819Z-831175/tree/contracts/foundry; RM=$P/rig-artifact-closure-stage/r2/run/20261026T034813Z/ARTIFACTS-after-final.sha256
  rm -rf $REPO/contracts/foundry/out && mkdir -p $REPO/contracts/foundry/out && (cd $OT && find out -type f -not -path 'out/build-info/*' -print0 | xargs -0 cp --parents -t $REPO/contracts/foundry/) || die "artifact copy"
  diff <(grep -v build-info $RM | LC_ALL=C sort -k2) <(cd $REPO/contracts/foundry && find out -type f | LC_ALL=C sort | xargs sha256sum | LC_ALL=C sort -k2) > $L/artifacts.diff || die "artifacts"
  RELAY_TESTS="native-relay-chain-authority platform-api-admin-cli platform-api-admin-status platform-api-forward platform-api-handoff-production platform-api-hosted platform-api-native-issuer relay-chain-consumers platform-api-registry platform-api-replica"
  for f in $RELAY_TESTS; do run $f 900 test/$f.test.mjs; done
else REL_COMMIT=; REL_TREE=; fi
cleanup

python3 -I - "$L" "$MODE" "$KVM_R3/expected-counts.json" "$SRC_COMMIT" "$NEW_TREE" "${REL_COMMIT:-}" "${REL_TREE:-}" "$OUT" "$RUNTIME_PIN" "$SCHED_PIN" <<'PY' > $OUT/verdict.json; rc=$?
import json, re, sys, pathlib
L, mode, kvmCounts, src, srcTree, rel, reltree, OUT, rtpin, sched = pathlib.Path(sys.argv[1]), sys.argv[2], json.load(open(sys.argv[3])), *sys.argv[4:11]
OUT = pathlib.Path(OUT)
def counts(n):
    s = (L / f"{n}.tap").read_text(errors="replace"); r = int((L / f"{n}.rc").read_text())
    return {"rc": r, **{k: int(m.group(1)) for k in ("tests", "pass", "fail", "skipped", "todo", "cancelled") for m in [re.search(rf"^# {k} (\d+)$", s, re.M)] if m}}
clean = lambda c, n: c["rc"] == 0 and c.get("tests") == n and c.get("pass") == n and not any(c.get(k) for k in ("fail", "skipped", "todo", "cancelled"))
out, ok = {"mode": mode, "sourceCommit": src, "sourceTree": srcTree, "scheduleReaderPin": {"old": "688b7a1f09c898f66cc7b92473a9fbda042402ef833bb983ff794e5f07128fb0", "new": sched}, "tests": {}}, True
def need(name, n):
    global ok
    c = counts(name); good = clean(c, n); out["tests"][name] = {**c, "expected": n, "ok": good}; ok = ok and good
need("two-anchor-reader", 13); need("two-anchor-reader-r2", 12); need("two-anchor-writer", 12); need("backward-history", 16); need("writer-history", 9)
for kf, n in kvmCounts.items(): need("kvm--" + kf.replace("/", "_"), n)
need("writer", 23); need("composition", 6); need("replica-exact", 8); need("enrollment", 19)
if mode == "check":
    kn = int((L / "kvm-native.rc").read_text()); out["tests"]["kvm-native"] = {"rc": kn, "ok": kn == 0}; ok = ok and kn == 0
    for name, n in (("endpoints", 6), ("platform-api-config", 5), ("relay-derived-reader-runtime", 4), ("paid-derived-packaging", 5),
                    ("native-relay-chain-authority", 8), ("platform-api-admin-cli", 9), ("platform-api-admin-status", 1), ("platform-api-forward", 6),
                    ("platform-api-handoff-production", 9), ("platform-api-hosted", 6), ("platform-api-native-issuer", 11), ("relay-chain-consumers", 10),
                    ("platform-api-registry", 1), ("platform-api-replica", 12)): need(name, n)
    t = (L / "overlay.txt").read_text(errors="replace"); orc = int((L / "overlay.rc").read_text())
    lines = re.findall(r"^(test_\w+) \(__main__\.(\w+)\.\w+\) \.\.\. (ok|FAIL|ERROR|skipped[^\n]*)$", t, re.M)
    ov = {"rc": orc, "tests": len(lines), "derivedReader": sum(c == "DerivedReaderOverlay" for _, c, _ in lines), "notOk": [(c, n, r) for n, c, r in lines if r != "ok"],
          "summaryOK": bool(re.search(r"^OK$", t, re.M))}
    ov["ok"] = orc == 0 and ov["tests"] == 25 and ov["derivedReader"] == 6 and not ov["notOk"] and ov["summaryOK"]; out["tests"]["overlay"] = ov; ok = ok and ov["ok"]
    su = (L / "startup.txt").read_text()
    selfTest = json.loads((L / "unenrolled-checker-selftest.json").read_text()); tree = json.loads((L / "unenrolled-tree.json").read_text())
    checkerOk = int((L / "unenrolled-checker-selftest.rc").read_text()) == 0 and selfTest.get("ok") is True and selfTest.get("fixtures") == 13 and all(r["pass"] for r in selfTest["results"])
    noState = checkerOk and int((L / "unenrolled-tree.rc").read_text()) == 0 and tree.get("ok") is True and not tree.get("violations")
    out["writerStartup"] = {"ok": su.count(": OK"), "fail": su.count(": FAIL"), "unenrolledCreatedNoState": noState}
    ok = ok and su.count(": OK") == 5 and ": FAIL" not in su and noState
    rt = (L / "network-runtime.sha256").read_text().strip(); out["sharedRelayRuntime"] = {"sha256": rt, "equalsPin": rt == rtpin}; ok = ok and rt == rtpin
    b = json.loads((L / "bundle.json").read_text())
    out["platformApiGuestBundle"] = {"committedStaleBefore": int((L / "platform-api-check--before.rc").read_text()) != 0,
        "checkAfterRegeneration": int((L / "platform-api-check--after.rc").read_text()), **b}; ok = ok and b["ok"]
    out["release"] = {"commit": rel, "tree": reltree, "generatedChanged": (L / "generated-changed.txt").read_text().split(),
                      "files": dict(l.split()[::-1] for l in (OUT / "RELEASE.sha256").read_text().splitlines() if l.strip())}
out["checkpoint"] = json.loads((L / "checkpoint.json").read_text())
out["ok"] = ok
out["scope"] = ("SOURCE + FIXTURES (r4 bounds: per-method byte caps, scan-wide call/byte budget, batch abort+settle; r3 repair: coverage-first writer, absolute-chunk lean bounded cache, signed pre-flighted raw method, bounded receipt concurrency, RAM resume, join-hash check): cold recovery of claims older than the start-time ASR anchor N by the authenticated backward header + receipt scan "
    "(floor..N, joined exactly to runtime coverage N+1..anchor), on the frozen two-anchor r3 path. Real Base headers for the parent-link walk and blooms; "
    "synthetic canonical receipts (no real receipt vector offline). NOT measured: scan cost from N to 52,515,705, own-node receipt/raw-transaction support, "
    "native time, S age (M1-M6). No driver (separate agent); no image template enabling any policy; not activated; production writer authority stays refused.")
print(json.dumps(out, indent=1)); sys.exit(0 if ok else 1)
PY
(cd $S && sha256sum -c --quiet SHA256SUMS) || { echo "## stage files changed during the run"; rc=1; }
rm -rf $OUT/repo $OUT/tmp
cat $OUT/verdict.json; echo "## outputs: $OUT"; echo "## writer-cold-recovery-r4 $MODE rc=$rc"; exit $rc
