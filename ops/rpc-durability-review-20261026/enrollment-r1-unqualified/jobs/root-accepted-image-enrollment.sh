#!/bin/bash
# accepted-image-enrollment-stage: ROOT job. The platform-api role's derived-reader ENROLLMENT and durable-state transport
# (logs/derived-state-ipc-contract.md; KVM API per logs/image-enrollment-root-note.txt), built and tested exactly the way
# accepted-image-assets-stage/r3 (root 1384 PASS) and the qualified r4 build:
#   source tree 583f2d7c = r4 929fc19a + r1 (5052bd58) + r2 (c0a5f4e4) + r3 (59e11251) + patches/accepted-image-enrollment-vs-r3.patch
# Modes (private user/net/mount namespace; one bounded, sequential run each; nothing outside $OUT is written):
#   check (2560 MiB): read-only bind-mounted node_modules, shared runtime pin e12c5baf, derived reader runtime + sidecars, the
#     platform-api guest bundle REGENERATED (it must carry the edited role, derived-state.mjs and the relay's committer) and
#     --check rc 0; the private RELEASE commit; then every test file sequentially and STRICTLY clean (no skip/todo/cancel, no
#     baseline equivalence): the new enrollment/IPC/replica suite (12), endpoints (6), overlay (25, real inputs), config,
#     writer (23), relay reader (4), KVM (33), the relay's 4 real startup refusals, and the relay/platform group.
#   image (1024 MiB): CHECK_RUN BASE OUT -> overlay-control-image.py --control direct from the check run's RELEASE commit. It
#     computes and accepts NO measurement.
#   cd /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025
#   bash jobs/q-exit-status.sh aie-enroll-check 2560 unshare -Urnm bash accepted-image-enrollment-stage/jobs/root-accepted-image-enrollment.sh check
#   bash jobs/q-exit-status.sh aie-enroll-image 1024 unshare -Urnm bash accepted-image-enrollment-stage/jobs/root-accepted-image-enrollment.sh image CHECK_RUN BASE OUT
set -uo pipefail
MODE=${1:-}; shift || true
case "$MODE" in check|image) ;; *) echo "usage: $0 check | image CHECK_RUN BASE OUT"; exit 2;; esac
ip link set lo up 2>/dev/null || true
P=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025
S1=$P/accepted-image-assets-stage; S2=$S1/r2; R3=$S1/r3; S=$P/accepted-image-enrollment-stage; F=$P/final-consumer-composition-stage; R4=$F/r4
T=$P/rpc-final-candidate-20261026/tree; HEAD=64156dcd91ff1e769e74f9c26a846be19254c716
LOCK=9ada1611f431d9cc804af46bea54a5aca9e92b44bee40000ee7e995e25d69f20; RUNTIME_PIN=e12c5bafb8b17abb891fb26fe1cdc054159d7bd2de5486d2c1a2480430671ed6
SCHED_PIN=688b7a1f09c898f66cc7b92473a9fbda042402ef833bb983ff794e5f07128fb0
BASE_TREE=929fc19a53e13a78d4d182f4eb969e76b619910d; R1_TREE=5052bd58e8399f9d5040aef911b91ca8632a2501
R2_TREE=c0a5f4e461f6383ced0fbc01e8b1a7569ded63c8; R3_TREE=59e112516acdb77040687a03729fa2b808ecbe00; NEW_TREE=583f2d7c3039ecbb04ce582f180e54546253a85e
# the qualified real image inputs (root 1361): reader inputs verified against the committed pins below; chain-verifier inputs are
# verified by the overlay tests themselves (they refuse any file that is not the pinned one)
READER_IN=$P/accepted-image-assets-stage/runs/run-20261026T135941Z-assets-1865301/inputs
CV_IN=$P/canonical-integration-actual/run/regress-20261026T005955Z/chain-verifier-inputs
BUDGET=${AIE_R3_BUDGET_SEC:-7200}     # whole-run bound (each step also has its own timeout)
OUT=$S/runs/$(date -u +%Y%m%dT%H%M%SZ)-$MODE-$$; L=$OUT/logs; export GIT_OPTIONAL_LOCKS=0
die() { echo "## INVALID: $*" | tee -a $OUT/setup.txt; echo "## accepted-image-enrollment $MODE rc=9"; exit 9; }
[ ! -e "$OUT" ] && mkdir -p $L $OUT/tmp || { echo "output dir"; exit 9; }
ip -o route 2>/dev/null | grep -q . && die "network route present: run under unshare -Urnm"
mount --make-rprivate / 2>/dev/null || die "no private mount namespace: run under unshare -Urnm"
# frozen inputs: r3 (this stage), r2 be7ba0cf, r1 2210d3e3, r4 afd35070 - each SUMS file pinned AND its files verified
(cd $S && sha256sum -c --quiet SHA256SUMS) || die "enrollment stage != SHA256SUMS"
while read -r dir sum; do   # (not "set --": image mode's own arguments must survive)
  [ "$(sha256sum < $dir/SHA256SUMS | cut -c1-64)" = $sum ] && (cd $dir && sha256sum -c --quiet SHA256SUMS) || die "$dir changed"
done <<EOF
$R3 3e20951705c683477b821bd3cffe8f53117150f6bdbe55545851a96badd0d14d
$S2 be7ba0cff04c32fa47e81ee15c1dbf3716a0063ec632517d104cbb49108345af
$S1 2210d3e35d3d9f02a9fe0311f39ebe86f551bbd98b856f43e36a4df1db59c245
$R4 afd35070b0a9751727df307aadb01458866b9e298618461d71a7fdfb0a919a0c
EOF
[ "$(cat $R4/FINAL-TREE)" = $BASE_TREE ] || die "r4 FINAL-TREE"
sha256sum < $S/SHA256SUMS | cut -c1-64 > $OUT/stage-sums.sha256
bindro() { local src=$1 dst=$2; [ -d "$src" ] || return 0; mkdir -p $dst && mount --bind "$src" $dst && mount -o remount,bind,ro $dst || die "bind $src"; }
cleanup() { for d in relay/node_modules network/node_modules node_modules; do umount $OUT/repo/$d 2>/dev/null || true; done; }
trap cleanup EXIT
export PATH=/home/steven/.foundry/bin:/usr/bin:/bin HOME=$OUT/tmp TMPDIR=$OUT/tmp TEST_TMP=$OUT/tmp FOUNDRY_OFFLINE=true

if [ $MODE = image ]; then
  [ $# = 3 ] || die "image CHECK_RUN BASE OUT"
  CK=$(readlink -f "$1"); BASE=$2; IMG=$3
  [ ! -e "$IMG" ] || die "OUT exists (never overwritten)"
  python3 -I -c 'import json,sys; v=json.load(open(sys.argv[1])); assert v["ok"] is True and v["mode"] == "check"; print(v["release"]["commit"], v["release"]["tree"], v["release"]["platformApiBundle"])' \
    $CK/verdict.json > $OUT/check-run.txt || die "CHECK_RUN has no ok check verdict"
  cmp -s $CK/stage-sums.sha256 $OUT/stage-sums.sha256 || die "CHECK_RUN was made by other stage bytes"
  read -r RC_COMMIT RC_TREE RC_BUNDLE < $OUT/check-run.txt
  git clone -q --no-hardlinks $CK/release.git $OUT/repo && git -C $OUT/repo checkout -q $RC_COMMIT || die "release checkout"
  [ "$(git -C $OUT/repo rev-parse $RC_COMMIT^{tree})" = $RC_TREE ] && [ "$(git -C $OUT/repo rev-parse $RC_COMMIT~1^{tree})" = $NEW_TREE ] || die "release commit is not source $NEW_TREE + generated files"
  (cd $OUT/repo && timeout -k 10 1200 python3 -I metal/overlay-control-image.py --control direct --chain-verifier-dir $CV_IN --derived-reader-dir $READER_IN "$BASE" "$IMG" $RC_COMMIT) \
    > $L/overlay.txt 2>&1 || { cat $L/overlay.txt; die "overlay refused"; }
  python3 -I - "$IMG/manifest.json" "$RC_BUNDLE" "$RC_COMMIT" <<'PY' | tee $OUT/verdict.json || die "the image does not record the release"
import json, sys
m, bundle, commit = json.load(open(sys.argv[1])), sys.argv[2], sys.argv[3]
r, pa = m["controlOverlay"]["derivedReader"], m["platformApiBundle"]
ok = m["controlOverlay"]["commit"] == commit and pa["sha256"] == bundle and "roleEnv" in r and \
     {"/opt/metal/derived-reader-runtime.bundle.mjs", "/opt/metal/schedule_reader.mjs"} <= set(pa.get("sidecars", {})) and "chainVerifier" in m["controlOverlay"]
print(json.dumps({"ok": ok, "mode": "image", "commit": commit, "initramfs": m.get("initramfs"), "platformApiBundle": pa, "derivedReader": r,
                  "scope": "an overlay image only: NO measurement accepted, NO SNP qualification, NOT activated"}, indent=1)); sys.exit(0 if ok else 1)
PY
  rc=$?; rm -rf $OUT/repo $OUT/tmp
  echo "NEXT (root, existing process): compute the expected SNP measurement for $IMG and qualify it; nothing here accepts a measurement."
  echo "## accepted-image-enrollment image rc=$rc"; exit $rc
fi

# ---- check ----
# 1. the reader inputs are the committed pins (from the composed tree below), and KVM's readCheckpoint still accepts the checkpoint
# 2. compose: r4 -> r1 -> r2 -> r3, every intermediate tree exact; tracked-but-ignored files force-added in the PRIVATE repo only
REPO=$OUT/repo; mkdir -p $REPO
git --git-dir=$R4/git archive $BASE_TREE | tar -x -C $REPO || die "archive r4 tree"
(cd $REPO && git init -q && git apply $S1/patches/accepted-image-assets-vs-r4.patch && git add -f -A && [ "$(git write-tree)" = $R1_TREE ] \
  && git apply $S2/patches/accepted-image-assets-r2-vs-r1.patch && git add -f -A && [ "$(git write-tree)" = $R2_TREE ] \
  && git apply $R3/patches/accepted-image-assets-r3-vs-r2.patch && git add -f -A && [ "$(git write-tree)" = $R3_TREE ] \
  && git apply $S/patches/accepted-image-enrollment-vs-r3.patch && git add -f -A && [ "$(git write-tree)" = $NEW_TREE ] \
  && git -c user.name=root -c user.email=root@localhost commit -qm "accepted-image-enrollment source $NEW_TREE") > $L/compose.txt 2>&1 || die "composed tree is not $NEW_TREE"
SRC_COMMIT=$(git -C $REPO rev-parse HEAD)
python3 -I - $REPO/metal/derived-reader-image.json $READER_IN <<'PY' > $L/reader-inputs.json || die "a reader input is not the pinned file"
import hashlib, json, os, sys
p, d = json.load(open(sys.argv[1])), sys.argv[2]
want = {os.path.basename(v["path"]): v["sha256"] for v in [*p["binaries"].values(), *p["files"].values()]}; want.update(p["glibcRuntime"]["files"])
got = {n: hashlib.sha256(open(os.path.join(d, n), "rb").read()).hexdigest() for n in want}
bad = {n: h for n, h in got.items() if h != want[n]}; print(json.dumps({"inputs": sorted(want), "mismatch": bad})); sys.exit(1 if bad else 0)
PY
# 3. the dependency tree and tools are the qualified ones; node_modules bound READ-ONLY into the private checkout (locks equal)
[ "$(git -C $T rev-parse HEAD)" = $HEAD ] && [ -z "$(git -C $T status --porcelain --untracked-files=no)" ] || die "candidate checkout is not a clean 64156dcd"
[ "$(sha256sum < $T/package-lock.json | cut -c1-64)" = $LOCK ] && grep -q '"version": "2.53.1"' $T/node_modules/viem/package.json || die "node_modules identity"
[ "$(sha256sum < "$(command -v anvil)" | cut -c1-64)" = 10c1c727d6c1de973aeb160e59875b9a9a23464d6e74149ee8abb30b3500311b ] || die "anvil is not the pinned one"
for d in . network relay; do cmp -s $T/$d/package-lock.json $REPO/$d/package-lock.json 2>/dev/null || [ ! -e $T/$d/package-lock.json ] || die "$d lock != the dependency tree's lock"
  bindro "$(readlink -f $T/$d/node_modules)" $REPO/$d/node_modules; done
(cd $REPO && env -i PATH=$PATH HOME=$OUT/tmp node --input-type=module -e "
  import { readCheckpoint } from './network/derived-reader/l1-runtime.mjs';
  const c = readCheckpoint('$READER_IN/checkpoint.json'); console.log(JSON.stringify({ checkpoint: c.digest, slot: c.slot,
    expiresUtc: new Date((c.timestamp + 604800) * 1000).toISOString() }));") > $L/checkpoint.json 2>&1 || die "KVM's readCheckpoint refuses the checkpoint (expired after 2026-11-01T19:21:59Z, or not reviewed): rotation is a reviewed source change"
# 4. release prerequisites in the r4 release order: shared runtime (pinned), reader runtime + sidecars, guest bundle regenerated
step() { [ $SECONDS -lt $BUDGET ] || die "run budget ${BUDGET}s exhausted before $1"; }
step build-network; (cd $REPO && timeout -k 10 600 node relay/build-network.mjs < /dev/null) > $L/build-network.out 2>&1 || die "build-network"
RT=$(sha256sum < $REPO/relay/network-runtime.bundle.mjs | cut -c1-64); echo $RT > $L/network-runtime.sha256
[ $RT = $RUNTIME_PIN ] || die "shared relay runtime $RT != pin $RUNTIME_PIN"
step build-derived-reader-runtime; (cd $REPO/relay && timeout -k 10 600 node build-derived-reader-runtime.mjs < /dev/null) > $L/build-derived-reader-runtime.out 2>&1 || die "build-derived-reader-runtime"
[ "$(sha256sum < $REPO/relay/schedule_reader.mjs | cut -c1-64)" = $SCHED_PIN ] || die "schedule_reader.mjs != pin"
step platform-api; (cd $REPO && timeout -k 10 900 node scripts/build-platform-api-guest-bundle.mjs --check < /dev/null) > $L/platform-api-check--before.out 2>&1; echo $? > $L/platform-api-check--before.rc
(cd $REPO && timeout -k 10 900 node scripts/build-platform-api-guest-bundle.mjs < /dev/null) > $L/platform-api-regenerate.out 2>&1 || die "platform-api regeneration"
(cd $REPO && timeout -k 10 900 node scripts/build-platform-api-guest-bundle.mjs --check < /dev/null) > $L/platform-api-check--after.out 2>&1; echo $? > $L/platform-api-check--after.rc
[ "$(cat $L/platform-api-check--after.rc)" = 0 ] || die "platform-api --check after regeneration"
# the regenerated bundle carries THIS role/verify code and the built sidecars
python3 -I - $REPO <<'PY' > $L/bundle.json || die "the regenerated bundle does not carry the edited role or the built sidecars"
import hashlib, json, sys, pathlib
r = pathlib.Path(sys.argv[1]); h = lambda p: hashlib.sha256((r / p).read_bytes()).hexdigest()
m = json.loads((r / "metal/guest/platform-api.bundle.mjs.manifest.json").read_text())
ok = m["sha256"] == h("metal/guest/platform-api.bundle.mjs") and all(m["inputs"].get(f) == h(f) for f in ("metal/guest/platform-api-role.mjs", "metal/guest/derived-state.mjs",
     "relay/derived-state-commit.mjs", "relay/derived-writer-authority.mjs")) \
  and all(m["sidecars"][b]["sha256"] == h(s) for b, s in (("derived-reader-runtime.bundle.mjs", "relay/derived-reader-runtime.bundle.mjs"), ("schedule_reader.mjs", "relay/schedule_reader.mjs")))
print(json.dumps({"ok": ok, "sha256": m["sha256"], "bytes": m["bytes"], "inputs": len(m["inputs"]), "role": m["inputs"].get("metal/guest/platform-api-role.mjs"),
                  "sidecars": {k: v["sha256"] for k, v in m["sidecars"].items()}})); sys.exit(0 if ok else 1)
PY
# 5. the private RELEASE commit: the source commit + exactly the generated files (the builds change no other tracked file)
GEN="metal/guest/platform-api.bundle.mjs metal/guest/platform-api.bundle.mjs.manifest.json relay/derived-reader-runtime.bundle.mjs relay/derived-reader-runtime.bundle.mjs.manifest.json relay/schedule_reader.mjs relay/network-runtime.bundle.mjs relay/network-runtime.bundle.mjs.manifest.json"
CHANGED=$(git -C $REPO diff --name-only | LC_ALL=C sort | paste -sd' ')
case "$CHANGED" in "" | "metal/guest/platform-api.bundle.mjs metal/guest/platform-api.bundle.mjs.manifest.json") ;; *) die "the builds changed other tracked files: $CHANGED";; esac
(cd $REPO && git add -f -- $GEN && git -c user.name=root -c user.email=root@localhost commit -qm "accepted-image-enrollment release (generated files)") || die "release commit"
REL_COMMIT=$(git -C $REPO rev-parse HEAD); REL_TREE=$(git -C $REPO rev-parse HEAD^{tree})
[ "$(git -C $REPO diff --name-only $SRC_COMMIT $REL_COMMIT | LC_ALL=C sort | paste -sd' ')" = "$(printf '%s\n' $GEN | LC_ALL=C sort | paste -sd' ')" ] || die "release != source + generated files"
git clone -q --bare --no-hardlinks $REPO $OUT/release.git || die "preserve release"
(cd $REPO && sha256sum $GEN) > $OUT/RELEASE.sha256
# 6. tests: sequential, strictly clean. Order: endpoint + image tests, integration (r4's integration inputs), relay (r4's relay inputs)
run() { local n=$1 lim=$2; shift 2; step $n
  (cd $REPO && env -i PATH=$PATH HOME=$OUT/tmp TMPDIR=$OUT/tmp TEST_TMP=$OUT/tmp FOUNDRY_OFFLINE=true ${NODE_OPTS:+NODE_OPTIONS=$NODE_OPTS} ${KVM:+KVM_TREE=$REPO} \
     timeout -k 10 $lim node --test --test-reporter=tap --test-concurrency=1 --test-timeout=600000 "$@" < /dev/null) > $L/$n.tap 2>&1; echo $? > $L/$n.rc; }
NODE_OPTS=--max-old-space-size=384 KVM=
run enrollment 900 test/derived-state-enrollment.test.mjs
run endpoints 600 test/derived-reader-endpoints.test.mjs
step overlay; (cd $REPO && env -i PATH=$PATH HOME=$OUT/tmp TMPDIR=$OUT/tmp PYTHONDONTWRITEBYTECODE=1 DERIVED_READER_INPUTS=$READER_IN CHAIN_VERIFIER_INPUTS=$CV_IN \
  timeout -k 5 1200 python3 -I test/metal-control-overlay.test.py -v) > $L/overlay.txt 2>&1; echo $? > $L/overlay.rc
run platform-api-config 900 test/platform-api-config.test.mjs
# integration inputs exactly as r4's integration mode: the two ABIs from the qualified dependency tree
git -C $REPO ls-files contracts/foundry/out | grep -q . && die "contracts/foundry/out is tracked"
for c in EnclaveDeployments EnclaveAddressBook; do mkdir -p $REPO/contracts/foundry/out/$c.sol && cp $T/contracts/foundry/out/$c.sol/$c.json $REPO/contracts/foundry/out/$c.sol/ || die "abi $c"; done
KVM=1 run writer 900 test/derived-writer-authority.test.mjs test/derived-writer-authority-abi.test.mjs test/derived-writer-authority-kvm-store.test.mjs
run relay-derived-reader-runtime 900 test/relay-derived-reader-runtime.test.mjs
step kvm; (cd $REPO && env -i PATH=/usr/bin:/bin HOME=$OUT/tmp TMPDIR=$OUT/tmp timeout 1200 node --test --test-timeout=120000 --test-reporter=tap --test-concurrency=1 test/derived-reader.test.mjs test/lifecycle-finality-bridge.test.mjs < /dev/null) > $L/kvm.tap 2>&1; echo $? > $L/kvm.rc
# the actual relay startup: r4's three writer refusals, and the ROLE-composed config (bound 10.0.2.2 endpoints, real pinned inputs)
# refusing because the reader state is not enrolled (initializeState false): no journal, coverage or anchor file may appear
BOOK=ADDRESS_BOOK_ADDRESS=0x7777777777777777777777777777777777777777
startup() { local name=$1 want=$2; shift 2
  (cd $REPO/relay && env -i PATH=$PATH HOME=$OUT/tmp API_RELAY_PORT=0 $BOOK "$@" timeout -k 5 90 node api-relay.js) > $L/startup-$name.txt 2>&1; local rc=$?
  if [ $rc = 1 ] && grep -q "fatal: writer authority: .*$want" $L/startup-$name.txt; then echo "startup $name: OK"; else echo "startup $name: FAIL (rc $rc)"; fi; }
step startup
UR=$OUT/tmp/unenrolled-role
(cd $REPO && env -i PATH=$PATH HOME=$OUT/tmp node $R3/jobs/unenrolled-startup-config.mjs $REPO $READER_IN $UR) > $L/unenrolled-compose.json 2> $L/unenrolled-compose.err || die "role composition for the startup case"
DENV=$(python3 -I -c 'import json,sys; e=json.load(open(sys.argv[1]))["env"]; print(" ".join(f"{k}={v}" for k,v in sorted(e.items())))' $L/unenrolled-compose.json)
{ startup no-verifier "needs the relay's verifier authority" ENCLAVE_WRITER_AUTHORITY_SOURCE=derived ENCLAVE_DERIVED_READER_CONFIG=/nonexistent/r.json ENCLAVE_DERIVED_ANCHOR_JOURNAL=/nonexistent/j.json
  startup bad-value 'must be "derived" or unset' ENCLAVE_WRITER_AUTHORITY_SOURCE=quorum
  startup url-config "absolute file path" ENCLAVE_CHAIN_AUTHORITY=verifier ENCLAVE_CHAIN_VERIFIER=http://127.0.0.1:9 ENCLAVE_WRITER_AUTHORITY_SOURCE=derived ENCLAVE_DERIVED_READER_CONFIG=http://127.0.0.1:9/reader ENCLAVE_DERIVED_ANCHOR_JOURNAL=/nonexistent/j.json
  startup unenrolled "explicit enrollment/recovery required" ENCLAVE_CHAIN_AUTHORITY=verifier ENCLAVE_CHAIN_VERIFIER=http://127.0.0.1:9 $DENV; } > $L/startup.txt
(cd $UR && find . -printf '%M %p\n' | LC_ALL=C sort) > $L/unenrolled-after.txt
# relay inputs exactly as r4's relay mode: the reviewed artifact set (replacing the two integration ABIs)
OT=$P/offchain-registration-fixture-stage/runs/20261026T040819Z-831175/tree/contracts/foundry; RM=$P/rig-artifact-closure-stage/r2/run/20261026T034813Z/ARTIFACTS-after-final.sha256
rm -rf $REPO/contracts/foundry/out && mkdir -p $REPO/contracts/foundry/out && (cd $OT && find out -type f -not -path 'out/build-info/*' -print0 | xargs -0 cp --parents -t $REPO/contracts/foundry/) || die "artifact copy"
diff <(grep -v build-info $RM | LC_ALL=C sort -k2) <(cd $REPO/contracts/foundry && find out -type f | LC_ALL=C sort | xargs sha256sum | LC_ALL=C sort -k2) > $L/artifacts.diff || die "artifacts"
NODE_OPTS=
RELAY_TESTS="native-relay-chain-authority platform-api-admin-cli platform-api-admin-status platform-api-forward platform-api-handoff-production platform-api-hosted platform-api-native-issuer relay-chain-consumers platform-api-registry platform-api-replica"
for f in $RELAY_TESTS; do run $f 900 test/$f.test.mjs; done
cleanup

python3 -I - "$L" "$P/rpc-final-candidate-20261026/TESTS.tsv" "$RUNTIME_PIN" "$OUT" "$SRC_COMMIT" "$REL_COMMIT" "$REL_TREE" "$RELAY_TESTS" <<'PY' > $OUT/verdict.json; rc=$?
import json, re, sys, pathlib
L, tsv, pin, OUT, src, rel, reltree, relay = pathlib.Path(sys.argv[1]), sys.argv[2], sys.argv[3], pathlib.Path(sys.argv[4]), sys.argv[5], sys.argv[6], sys.argv[7], sys.argv[8].split()
def counts(n):
    s = (L / f"{n}.tap").read_text(errors="replace"); r = int((L / f"{n}.rc").read_text())
    return {"rc": r, **{k: int(m.group(1)) for k in ("tests", "pass", "fail", "skipped", "todo", "cancelled") for m in [re.search(rf"^# {k} (\d+)$", s, re.M)] if m}}
clean = lambda c, n=None: c["rc"] == 0 and c.get("tests", 0) > 0 and c.get("pass") == c.get("tests") and (n is None or c.get("tests") == n) and not any(c.get(k) for k in ("fail", "skipped", "todo", "cancelled"))
want = {l.split("\t")[0]: l.split("\t")[1] for l in open(tsv) if l.startswith("test/")}
out, ok = {"mode": "check", "harness": "r4 strict layout: read-only bind-mounted node_modules, private user/net/mount namespace, sequential files"}, True
def need(name, c, n=None):
    global ok
    good = clean(c, n); out.setdefault("tests", {})[name] = {**c, "expected": n, "ok": good}; ok = ok and good
need("enrollment", counts("enrollment"), 12)
need("endpoints", counts("endpoints"), 6)
t = (L / "overlay.txt").read_text(errors="replace"); orc = int((L / "overlay.rc").read_text())
lines = re.findall(r"^(test_\w+) \(__main__\.(\w+)\.\w+\) \.\.\. (ok|FAIL|ERROR|skipped[^\n]*)$", t, re.M)
ov = {"rc": orc, "tests": len(lines), "derivedReader": sum(c == "DerivedReaderOverlay" for _, c, _ in lines),
      "notOk": [(c, n, r) for n, c, r in lines if r != "ok"], "summaryOK": bool(re.search(r"^OK$", t, re.M))}
ov["ok"] = orc == 0 and ov["tests"] == 25 and ov["derivedReader"] == 6 and not ov["notOk"] and ov["summaryOK"]; out["tests"]["overlay"] = ov; ok = ok and ov["ok"]
# the counts root 1384 recorded on r3 (accepted-image-assets-stage/r3/runs/20261026T143939Z-check-1907540/verdict.json): unchanged suites keep them
R3N = {"platform-api-config": 5, "platform-api-admin-cli": 9, "platform-api-admin-status": 1, "platform-api-forward": 6, "platform-api-handoff-production": 9,
       "platform-api-hosted": 6, "platform-api-native-issuer": 11, "platform-api-registry": 1, "platform-api-replica": 12}
need("platform-api-config", counts("platform-api-config"), 5)
need("writer", counts("writer"), 23); need("relay-derived-reader-runtime", counts("relay-derived-reader-runtime"), 4); need("kvm", counts("kvm"), 33)
for f in relay:
    e = want.get(f"test/{f}.test.mjs", "-"); need(f, counts(f), R3N.get(f, None if e == "-" else int(e)))
su = (L / "startup.txt").read_text(); after = (L / "unenrolled-after.txt").read_text()
# (derived-state.lock may remain: KVM's runtime lock is taken before the refusal and is never unlinked; it holds no state)
noState = not any(x in after for x in ("derived-state.json", "coverage", "anchor-journal.json", "/runs"))
out["writerStartup"] = {"ok": su.count(": OK"), "fail": su.count(": FAIL"), "unenrolledCreatedNoState": noState, "unenrolledTree": after.splitlines()}
ok = ok and su.count(": OK") == 4 and ": FAIL" not in su and noState
rt = (L / "network-runtime.sha256").read_text().strip(); out["sharedRelayRuntime"] = {"sha256": rt, "equalsPin": rt == pin}; ok = ok and rt == pin
b = json.loads((L / "bundle.json").read_text())
out["platformApiGuestBundle"] = {"committedStaleBefore": int((L / "platform-api-check--before.rc").read_text()) != 0,
    "checkAfterRegeneration": int((L / "platform-api-check--after.rc").read_text()), **b}; ok = ok and b["ok"]
out["release"] = {"sourceCommit": src, "commit": rel, "tree": reltree, "platformApiBundle": b["sha256"],
                  "files": dict(l.split()[::-1] for l in (OUT / "RELEASE.sha256").read_text().splitlines() if l.strip())}
out["checkpoint"] = json.loads((L / "checkpoint.json").read_text())
out["ok"] = ok
out["scope"] = "offline: role enrollment + private-IPC durable-commit transport over in-process co-located replicas (NOT a distinct-host quorum), packaging and refusals. NO KVM durable-state implementation (pending), NO chain read, NO SNP, NOT activated; writer authority stays unproven (fixed 120 s ceiling vs L1-finalized anchors)"
print(json.dumps(out, indent=1)); sys.exit(0 if ok else 1)
PY
(cd $S && sha256sum -c --quiet SHA256SUMS) || { echo "## stage files changed during the run"; rc=1; }
rm -rf $OUT/repo $OUT/tmp
cat $OUT/verdict.json; echo "## outputs: $OUT (release.git preserved for image mode)"; echo "## accepted-image-enrollment check rc=$rc"; exit $rc
