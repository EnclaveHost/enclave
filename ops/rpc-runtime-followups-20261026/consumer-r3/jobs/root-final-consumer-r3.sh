#!/bin/bash
# final-consumer-composition-stage/r3: ROOT job for the release-candidate tree 7dc8f162 (r2 20dbe573 + patches/guest-sidecars-vs-r2.patch:
# the relay's derived-reader runtime and its pinned schedule reader become MEASURED platform-api guest sidecars; one test added).
# No network, no native build, no activation; nothing written outside $OUT. MOUNT namespace required (dependencies are BIND-MOUNTED
# read-only as real in-tree node_modules directories - never symlinks: a symlink makes esbuild record inputs outside the tree, which
# changes bundle bytes and is rightly rejected by scripts/locked-inputs.mjs; root 1320). If consumer-package-inputs-stage (da)
# freezes a different dependency recipe, root adopts that recipe here; this job never weakens a pin or the outside-tree check.
#   cd /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025
#   bash jobs/q-exit-status.sh final-consumer-r3-package      768 unshare -Urnm bash final-consumer-composition-stage/r3/jobs/root-final-consumer-r3.sh package
#   bash jobs/q-exit-status.sh final-consumer-r3-integration  768 unshare -Urnm bash final-consumer-composition-stage/r3/jobs/root-final-consumer-r3.sh integration
#   bash jobs/q-exit-status.sh final-consumer-r3-relay       2560 unshare -Urnm bash final-consumer-composition-stage/r3/jobs/root-final-consumer-r3.sh relay
#   bash jobs/q-exit-status.sh final-consumer-r3-mutants      512 unshare -Urnm bash final-consumer-composition-stage/r3/jobs/root-final-consumer-r3.sh mutants
# STRICT: generated artifacts must check rc 0 (no baseline-failure equality); the shared relay runtime bundle must equal its committed
# pin; the paid adapter/packaging/mutants run FRESH on this tree (the helper relocation changed their source vs paid-v3 5037054a).
set -uo pipefail
MODE=${1:-package}; case $MODE in package|integration|relay|mutants) ;; *) echo "usage: $0 package|integration|relay|mutants"; exit 2;; esac
ip link set lo up 2>/dev/null || true
P=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025
F=$P/final-consumer-composition-stage; ST=$F/r3; WS=$P/finalized-writer-integration-stage; R4=$P/paid-derived-adapter-stage
T=$P/rpc-final-candidate-20261026/tree; HEAD=64156dcd91ff1e769e74f9c26a846be19254c716
LOCK=9ada1611f431d9cc804af46bea54a5aca9e92b44bee40000ee7e995e25d69f20; RUNTIME_PIN=e12c5bafb8b17abb891fb26fe1cdc054159d7bd2de5486d2c1a2480430671ed6
OUT=$ST/runs/$(date -u +%Y%m%dT%H%M%SZ)-$MODE-$$; L=$OUT/logs; export GIT_OPTIONAL_LOCKS=0
die() { echo "## INVALID: $*"; echo "## final-consumer-r3 $MODE rc=1"; exit 1; }
[ ! -e "$OUT" ] && mkdir -p $L $OUT/tmp || die "output dir"
ip -o route 2>/dev/null | grep -q . && die "network route present: run under unshare -Urnm"
mount --make-rprivate / 2>/dev/null || die "no private mount namespace: run under unshare -Urnm"
(cd $ST && sha256sum -c --quiet SHA256SUMS) || die "r3 != SHA256SUMS"
(cd $F/r2 && sha256sum -c --quiet SHA256SUMS) && cmp -s $F/r2/SHA256SUMS $ST/inputs/r2-SHA256SUMS || die "r2 changed"
(cd $F && sha256sum -c --quiet SHA256SUMS) && cmp -s $F/SHA256SUMS $ST/inputs/r1-SHA256SUMS || die "r1 changed"
(cd $WS/r3 && sha256sum -c --quiet SHA256SUMS) && (cd $R4 && sha256sum -c --quiet SHA256SUMS) || die "writer r3 / paid r4 changed"
R2T=$(cat $F/r2/FINAL-TREE); FINAL=$(cat $ST/FINAL-TREE)
G=$OUT/git; git init -q --bare $G && { cat $ST/git/objects/info/alternates; echo $ST/git/objects; } > $G/objects/info/alternates || die "private git"
GIT=(git --git-dir=$G)
tree_of() { local dir=$1 idx=$OUT/idx.$RANDOM; GIT_INDEX_FILE=$idx "${GIT[@]}" read-tree $HEAD && (cd $dir && GIT_INDEX_FILE=$idx "${GIT[@]}" --work-tree=$dir add -A -f . >/dev/null) && GIT_INDEX_FILE=$idx "${GIT[@]}" write-tree; rm -f $idx; }
mkdir -p $OUT/rb/a $OUT/rb/b
"${GIT[@]}" archive $HEAD | tar -x -C $OUT/rb/a && (cd $OUT/rb/a && git apply --whitespace=nowarn $ST/patches/final-consumer-r3-vs-64156.patch) || die "base + r3 patch"
"${GIT[@]}" archive $R2T | tar -x -C $OUT/rb/b && (cd $OUT/rb/b && git apply --whitespace=nowarn $ST/patches/guest-sidecars-vs-r2.patch) || die "r2 + sidecar patch"
TA=$(tree_of $OUT/rb/a); TB=$(tree_of $OUT/rb/b); rm -rf $OUT/rb
[ "$TA" = $FINAL ] && [ "$TB" = $FINAL ] || die "r3 tree does not reproduce ($TA, $TB, recorded $FINAL)"
while read -r b f; do [ "$("${GIT[@]}" rev-parse $FINAL:$f)" = $b ] || die "blob of $f"; done < $ST/R3-BLOBS.txt
"${GIT[@]}" diff --name-only $HEAD $FINAL | grep -E '^(windows/|test/windows-)' && die "the Windows path changed"
[ "$("${GIT[@]}" rev-parse $FINAL:relay/network-runtime.mjs)" = "$("${GIT[@]}" rev-parse $HEAD:relay/network-runtime.mjs)" ] && [ "$("${GIT[@]}" rev-parse $FINAL:network/onchain-qualification.mjs)" = "$("${GIT[@]}" rev-parse $HEAD:network/onchain-qualification.mjs)" ] || die "shared runtime sources changed"
[ "$(git -C $T rev-parse HEAD)" = $HEAD ] && [ -z "$(git -C $T status --porcelain --untracked-files=no)" ] || die "candidate checkout is not a clean 64156dcd"
[ "$(sha256sum < $T/package-lock.json | cut -c1-64)" = $LOCK ] && grep -q '"version": "2.53.1"' $T/node_modules/viem/package.json || die "node_modules identity"
export PATH=/home/steven/.foundry/bin:/usr/bin:/bin HOME=$OUT/tmp TMPDIR=$OUT/tmp TEST_TMP=$OUT/tmp FOUNDRY_OFFLINE=true
[ $MODE = relay ] || export NODE_OPTIONS=--max-old-space-size=384
[ "$(sha256sum < "$(command -v anvil)" | cut -c1-64)" = 10c1c727d6c1de973aeb160e59875b9a9a23464d6e74149ee8abb30b3500311b ] || die "anvil is not the pinned one"
bindro() { local src=$1 dst=$2; [ -d "$src" ] || return 0; mkdir -p $dst && mount --bind "$src" $dst && mount -o remount,bind,ro $dst || die "bind $src"; }
for side in pristine final; do src=$HEAD; [ $side = final ] && src=$FINAL
  mkdir -p $OUT/$side && "${GIT[@]}" archive $src | tar -x -C $OUT/$side || die "export $side"
  for d in . network relay; do cmp -s $T/$d/package-lock.json $OUT/$side/$d/package-lock.json 2>/dev/null || [ ! -e $T/$d/package-lock.json ] || die "$side $d lock != the dependency tree's lock"
    bindro "$(readlink -f $T/$d/node_modules)" $OUT/$side/$d/node_modules; done
  (cd $OUT/$side && timeout -k 10 600 node relay/build-network.mjs < /dev/null) > $L/build-network--$side.out 2>&1 || die "build-network ($side)"
done
cmp -s $OUT/pristine/relay/network-runtime.bundle.mjs $OUT/final/relay/network-runtime.bundle.mjs || die "the shared relay runtime bundle differs from the base build"
RT=$(sha256sum < $OUT/final/relay/network-runtime.bundle.mjs | cut -c1-64); echo $RT > $L/network-runtime.sha256
# the final tree's release prerequisites, in release order: relay reader runtime, then the measured guest bundle (its sidecars)
(cd $OUT/final/relay && timeout -k 10 600 node build-derived-reader-runtime.mjs < /dev/null) > $L/build-derived-reader-runtime.out 2>&1 || die "build-derived-reader-runtime"
(cd $OUT/final && timeout -k 10 900 node scripts/build-platform-api-guest-bundle.mjs --check < /dev/null) > $L/platform-api-check--before.out 2>&1; echo $? > $L/platform-api-check--before.rc
(cd $OUT/final && timeout -k 10 900 node scripts/build-platform-api-guest-bundle.mjs < /dev/null) > $L/platform-api-regenerate.out 2>&1 || die "platform-api regeneration"
(cd $OUT/final && timeout -k 10 900 node scripts/build-platform-api-guest-bundle.mjs --check < /dev/null) > $L/platform-api-check--after.out 2>&1; echo $? > $L/platform-api-check--after.rc
run() { local side=$1 f=$2 n; n=$side--$(basename $f .mjs)
  (cd $OUT/$side && timeout -k 10 900 node --test --test-reporter=tap --test-concurrency=1 --test-timeout=600000 $f < /dev/null) > $L/$n.tap 2>&1; echo $? > $L/$n.rc; }
BOOK=ADDRESS_BOOK_ADDRESS=0x7777777777777777777777777777777777777777
startup() { local name=$1 want=$2; shift 2
  (cd $OUT/final/relay && env -i PATH=$PATH HOME=$OUT/tmp API_RELAY_PORT=0 $BOOK "$@" timeout -k 5 90 node api-relay.js) > $L/startup-$name.txt 2>&1; local rc=$?
  if [ $rc = 1 ] && grep -q "fatal: writer authority: .*$want" $L/startup-$name.txt; then echo "startup $name: OK"; else echo "startup $name: FAIL (rc $rc)"; fi; }

if [ $MODE = package ]; then
  for side in pristine final; do
    (cd $OUT/$side && timeout -k 10 900 node scripts/build-host-service-packages.mjs --check < /dev/null) > $L/host-packages-check--$side.out 2>&1; echo $? > $L/host-packages-check--$side.rc
    (cd $OUT/$side && timeout -k 10 900 node scripts/build-mcp-guest-bundle.mjs --check < /dev/null) > $L/mcp-bundle-check--$side.out 2>&1; echo $? > $L/mcp-bundle-check--$side.rc
  done
  (cd $OUT/final && timeout -k 10 900 node scripts/network/build-consumers.mjs $OUT/release/consumers < /dev/null) > $L/build-consumers.out 2>&1; echo $? > $L/build-consumers.rc
  mkdir -p $OUT/release/relay $OUT/release/metal-guest
  cp $OUT/final/relay/network-runtime.bundle.mjs $OUT/final/relay/network-runtime.bundle.mjs.manifest.json $OUT/final/relay/derived-reader-runtime.bundle.mjs \
     $OUT/final/relay/derived-reader-runtime.bundle.mjs.manifest.json $OUT/final/relay/schedule_reader.mjs $OUT/release/relay/
  cp $OUT/final/metal/guest/platform-api.bundle.mjs $OUT/final/metal/guest/platform-api.bundle.mjs.manifest.json $OUT/release/metal-guest/
  (cd $OUT/release && find . -type f | LC_ALL=C sort | xargs sha256sum) > $OUT/RELEASE.sha256
  node --check $OUT/final/relay/api-relay.js > $L/relay-check.out 2>&1; echo $? > $L/relay-check.rc
  run pristine test/relay-deploy-closure.test.mjs; run final test/relay-deploy-closure.test.mjs
fi
if [ $MODE = integration ]; then
  { startup no-verifier "needs the relay's verifier authority" ENCLAVE_WRITER_AUTHORITY_SOURCE=derived ENCLAVE_DERIVED_READER_CONFIG=/nonexistent/r.json ENCLAVE_DERIVED_ANCHOR_JOURNAL=/nonexistent/j.json
    startup bad-value 'must be "derived" or unset' ENCLAVE_WRITER_AUTHORITY_SOURCE=quorum
    startup url-config "absolute file path" ENCLAVE_CHAIN_AUTHORITY=verifier ENCLAVE_CHAIN_VERIFIER=http://127.0.0.1:9 ENCLAVE_WRITER_AUTHORITY_SOURCE=derived ENCLAVE_DERIVED_READER_CONFIG=http://127.0.0.1:9/reader ENCLAVE_DERIVED_ANCHOR_JOURNAL=/nonexistent/j.json; } > $L/startup.txt
  run final test/relay-derived-reader-runtime.test.mjs
  for c in EnclaveDeployments EnclaveAddressBook; do mkdir -p $OUT/final/contracts/foundry/out/$c.sol && cp $T/contracts/foundry/out/$c.sol/$c.json $OUT/final/contracts/foundry/out/$c.sol/ || die "abi $c"; done
  (cd $OUT/final && KVM_TREE=$OUT/final timeout -k 5 600 node --test --test-reporter=tap --test-concurrency=1 test/derived-writer-authority.test.mjs test/derived-writer-authority-abi.test.mjs test/derived-writer-authority-kvm-store.test.mjs < /dev/null) > $L/writer.tap 2>&1; echo $? > $L/writer.rc
  (cd $OUT/final && env -i PATH=/usr/bin:/bin HOME=$OUT/tmp TMPDIR=$OUT/tmp timeout 1200 node --test --test-timeout=120000 --test-reporter=tap test/derived-reader.test.mjs test/lifecycle-finality-bridge.test.mjs < /dev/null) > $L/kvm.tap 2>&1; echo $? > $L/kvm.rc
  run final test/paid-derived-adapter.test.mjs; run final test/paid-derived-packaging.test.mjs
  for f in test/stack-provider-authority.test.mjs test/attested-provider-collateral.test.mjs test/wg-provider.test.mjs test/paid-network.test.mjs test/verified-chain.test.mjs \
           test/service-index.test.mjs test/attested-paid-provider.test.mjs test/attested-route-composition.test.mjs test/attested-chain-verifier.test.mjs test/windows-node-lease-renewal-keeper.test.mjs; do
    run pristine $f; run final $f; done
fi
if [ $MODE = relay ]; then
  OT=$P/offchain-registration-fixture-stage/runs/20261026T040819Z-831175/tree/contracts/foundry; RM=$P/rig-artifact-closure-stage/r2/run/20261026T034813Z/ARTIFACTS-after-final.sha256
  for side in pristine final; do
    mkdir -p $OUT/$side/contracts/foundry/out && (cd $OT && find out -type f -not -path 'out/build-info/*' -print0 | xargs -0 cp --parents -t $OUT/$side/contracts/foundry/) || die "artifact copy $side"
    diff <(grep -v build-info $RM | LC_ALL=C sort -k2) <(cd $OUT/$side/contracts/foundry && find out -type f | LC_ALL=C sort | xargs sha256sum | LC_ALL=C sort -k2) > $L/artifacts--$side.diff || die "artifacts ($side)"
  done
  for f in test/native-relay-chain-authority.test.mjs test/platform-api-admin-cli.test.mjs test/platform-api-admin-status.test.mjs test/platform-api-forward.test.mjs \
           test/platform-api-handoff-production.test.mjs test/platform-api-hosted.test.mjs test/platform-api-native-issuer.test.mjs test/relay-chain-consumers.test.mjs; do
    run pristine $f; run final $f; done
fi
if [ $MODE = mutants ]; then
  run final test/paid-derived-adapter.test.mjs
  D=$OUT/final/network/wg-provider/derived-submission.mjs; cp $D $OUT/derived-submission.orig
  python3 -I -c 'import json,sys; [print(m["name"]) for m in json.load(open(sys.argv[1]))]' $R4/jobs/mutants.json > $OUT/mutant-names.txt
  while read -r name; do
    python3 -I - "$R4/jobs/mutants.json" "$name" "$D" <<'PY' || die "mutant $name does not apply"
import json, sys
m = next(x for x in json.load(open(sys.argv[1])) if x["name"] == sys.argv[2]); s = open(sys.argv[3]).read()
assert s.count(m["find"]) == 1; open(sys.argv[3], "w").write(s.replace(m["find"], m["replace"]))
PY
    (cd $OUT/final && timeout -k 10 300 node --test --test-reporter=tap --test-concurrency=1 --test-timeout=120000 test/paid-derived-adapter.test.mjs < /dev/null) > $L/mutant--$name.tap 2>&1; echo $? > $L/mutant--$name.rc
    cp $OUT/derived-submission.orig $D
  done < $OUT/mutant-names.txt
fi

python3 -I - "$L" "$MODE" "$P/rpc-final-candidate-20261026/TESTS.tsv" "$RUNTIME_PIN" "$OUT" <<'PY' > $OUT/verdict.json; rc=$?
import json, re, sys, pathlib
L, mode, tsv, pin, OUT = pathlib.Path(sys.argv[1]), sys.argv[2], sys.argv[3], sys.argv[4], pathlib.Path(sys.argv[5])
def counts(name):
    s = (L / f"{name}.tap").read_text(errors="replace"); r = int((L / f"{name}.rc").read_text())
    return {"rc": r, **{k: int(m.group(1)) for k in ("tests", "pass", "fail", "skipped", "todo", "cancelled") for m in [re.search(rf"^# {k} (\d+)$", s, re.M)] if m}}
clean = lambda c, n=None: c["rc"] == 0 and c.get("tests", 0) > 0 and c.get("pass") == c.get("tests") and (n is None or c.get("tests") == n) and not any(c.get(k) for k in ("fail", "skipped", "todo", "cancelled"))
rcf = lambda n: int((L / f"{n}.rc").read_text())
def same(f):
    a, b = counts(f"pristine--{f}"), counts(f"final--{f}")
    return {"pristine": a, "final": b, "same": all(a.get(k) == b.get(k) for k in ("tests", "pass", "fail", "skipped", "todo", "cancelled")) and a["rc"] == b["rc"], "finalClean": clean(b)}
out, ok = {"mode": mode, "harness": "bind-mounted read-only node_modules (unshare -Urnm)"}, True
rt = (L / "network-runtime.sha256").read_text().strip()
out["sharedRelayRuntime"] = {"sha256": rt, "equalsBaseBuild": True, "equalsCommittedPin": rt == pin}
if mode == "package": ok = ok and rt == pin      # the committed host-package / guest-manifest pin
pb, pa = rcf("platform-api-check--before"), rcf("platform-api-check--after")
out["platformApiGuestBundle"] = {"committedStale": pb != 0, "checkAfterRegeneration": pa}; ok = ok and pa == 0
if mode == "package":
    st = {k: {s: rcf(f"{k}--{s}") for s in ("pristine", "final")} for k in ("host-packages-check", "mcp-bundle-check")}
    out["committedGeneratedArtifacts"] = st
    ok = ok and st["host-packages-check"]["final"] == 0 and st["mcp-bundle-check"]["final"] == 0      # STRICT: success, not equal failure
    ok = ok and rcf("build-consumers") == 0 and rcf("relay-check") == 0
    rel = {l.split()[1]: l.split()[0] for l in (OUT / "RELEASE.sha256").read_text().splitlines() if l.strip()}
    man = json.loads((OUT / "release" / "metal-guest" / "platform-api.bundle.mjs.manifest.json").read_text())
    side = man.get("sidecars", {})
    guestShips = side.get("derived-reader-runtime.bundle.mjs", {}).get("sha256") == rel.get("./relay/derived-reader-runtime.bundle.mjs") and \
                 side.get("schedule_reader.mjs", {}).get("sha256") == "688b7a1f09c898f66cc7b92473a9fbda042402ef833bb983ff794e5f07128fb0" == rel.get("./relay/schedule_reader.mjs")
    out["release"] = rel; out["guestShipsReaderRuntime"] = guestShips; ok = ok and guestShips
    d = same("relay-deploy-closure.test"); out["relayDeployClosure"] = d; ok = ok and d["finalClean"] and d["pristine"]["rc"] == 0
if mode == "integration":
    su = (L / "startup.txt").read_text(); out["writerStartup"] = {"ok": su.count(": OK"), "fail": su.count(": FAIL")}; ok = ok and su.count(": OK") == 3 and ": FAIL" not in su
    t = counts("final--relay-derived-reader-runtime.test"); out["relayReaderTest"] = t; ok = ok and clean(t, 4)
    w = counts("writer"); out["writer"] = w; ok = ok and clean(w, 23)
    k = counts("kvm"); out["kvmReader"] = k; ok = ok and clean(k, 33)
    a = counts("final--paid-derived-adapter.test"); p = counts("final--paid-derived-packaging.test"); out["paidAdapter"] = a; out["paidPackaging"] = p
    pt = (L / "final--paid-derived-packaging.test.tap").read_text(errors="replace")
    nested = re.search(r"^[ ]*# nested adapter suite: tests 15 pass 15 fail 0 skipped 0 todo 0 cancelled 0 against \S+/release/derived-runtime\.mjs$", pt, re.M)
    out["paidNestedSuite"] = bool(nested); ok = ok and clean(a, 15) and clean(p, 5) and bool(nested) and "called recursively" not in pt
    out["regression"] = {}
    for f in ("stack-provider-authority", "attested-provider-collateral", "wg-provider", "paid-network", "verified-chain", "service-index", "attested-paid-provider",
              "attested-route-composition", "attested-chain-verifier", "windows-node-lease-renewal-keeper"):
        r = same(f + ".test"); out["regression"][f] = r; ok = ok and r["same"] and r["finalClean"]
if mode == "relay":
    want = {l.split("\t")[0]: l.split("\t")[1] for l in open(tsv) if l.startswith("test/")}
    out["relayTests"] = {}
    for f in ("native-relay-chain-authority", "platform-api-admin-cli", "platform-api-admin-status", "platform-api-forward", "platform-api-handoff-production",
              "platform-api-hosted", "platform-api-native-issuer", "relay-chain-consumers"):
        r = same(f + ".test"); e = want.get(f"test/{f}.test.mjs", "-"); r["expected"] = e
        good = r["same"] and r["finalClean"] and (e == "-" or r["final"].get("tests") == int(e)); r["ok"] = good; out["relayTests"][f] = r; ok = ok and good
if mode == "mutants":
    b = counts("final--paid-derived-adapter.test"); out["baseline"] = b; ok = ok and clean(b, 15)
    out["mutants"] = {}
    for t in sorted(L.glob("mutant--*.tap")):
        s = t.read_text(errors="replace"); r = int(t.with_suffix(".rc").read_text()); f = re.search(r"^# fail (\d+)$", s, re.M); n = re.search(r"^# tests (\d+)$", s, re.M)
        killed = r != 0 and n is not None and int(n.group(1)) == 15 and f is not None and int(f.group(1)) >= 1
        out["mutants"][t.stem.split("--", 1)[1]] = {"rc": r, "killed": killed}; ok = ok and killed
    ok = ok and len(out["mutants"]) == 12
out["ok"] = ok
out["scope"] = "release-candidate tree 7dc8f162: packaging/composition/adapter evidence only; NOT fresh-state authority (writer 120 s ceiling vs L1-finalized anchors), NOT feature availability, NOT production"
print(json.dumps(out, indent=1)); sys.exit(0 if ok else 1)
PY
(cd $ST && sha256sum -c --quiet SHA256SUMS) || { echo "## stage files changed during the run"; rc=1; }
for side in pristine final; do for d in relay/node_modules network/node_modules node_modules; do umount $OUT/$side/$d 2>/dev/null || true; done; done
rm -rf $OUT/pristine $OUT/final $OUT/tmp $OUT/git
cat $OUT/verdict.json; echo "## outputs: $OUT"; echo "## final-consumer-r3 $MODE rc=$rc"; exit $rc
