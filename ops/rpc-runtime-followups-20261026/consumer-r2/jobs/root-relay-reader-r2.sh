#!/bin/bash
# final-consumer-composition-stage/r2: ROOT job for the relay derived-reader composition (tree 20dbe573 = r1 33e9cabc +
# patches/relay-reader-vs-r1.patch: 6 files, relay-only + .gitignore + one new test). No network, no native build, no activation.
#   cd /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025
#   bash jobs/q-exit-status.sh relay-reader-r2        768 unshare -Urn bash final-consumer-composition-stage/r2/jobs/root-relay-reader-r2.sh relay-reader
#   bash jobs/q-exit-status.sh relay-reader-r2-relay 2560 unshare -Urn bash final-consumer-composition-stage/r2/jobs/root-relay-reader-r2.sh relay
# MINIMAL AFFECTED SCOPE (r2 changes only relay/api-relay.js, relay/deploy.sh, two new relay files, .gitignore, one new test):
#   relay-reader: tree reproduction; the shared network runtime bundle r1 == r2 byte for byte; host-service packages / MCP status
#     == r1; CONTROL before the derived runtime is built: derived selector -> "not composed"; the release prerequisite
#     node relay/build-derived-reader-runtime.mjs; the new test (3: build+pins, the PACKAGED runtime starting KVM's committed
#     reader in-process on KVM's labelled fixtures with the writer refusing, the real api-relay.js reaching KVM's own refusals;
#     unset unchanged); writer r3's 3 non-composition startup cases (no-verifier, bad-value, url-config); the writer's 3 suites
#     (23); relay-deploy-closure r1 vs r2; the platform-api guest bundle regenerated (stale before, --check after) and carrying
#     NO derived reader code (the guest stays "not composed").
#   relay: the 8 api-relay.js-dependent candidate tests, base 64156dcd vs r2 (as r1's relay mode).
# Not in scope (no closure change from r1): paid, KVM reader, provider package, Windows - r1's package/integration/mutants apply.
set -uo pipefail
MODE=${1:-relay-reader}; case $MODE in relay-reader|relay) ;; *) echo "usage: $0 relay-reader|relay"; exit 2;; esac
ip link set lo up 2>/dev/null || true
P=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025
R1S=$P/final-consumer-composition-stage; ST=$R1S/r2; WS=$P/finalized-writer-integration-stage
T=$P/rpc-final-candidate-20261026/tree; HEAD=64156dcd91ff1e769e74f9c26a846be19254c716
LOCK=9ada1611f431d9cc804af46bea54a5aca9e92b44bee40000ee7e995e25d69f20
OUT=$ST/runs/$(date -u +%Y%m%dT%H%M%SZ)-$MODE-$$; L=$OUT/logs; export GIT_OPTIONAL_LOCKS=0
die() { echo "## INVALID: $*"; echo "## relay-reader-r2 $MODE rc=1"; exit 1; }
[ ! -e "$OUT" ] && mkdir -p $L $OUT/tmp || die "output dir"
ip -o route 2>/dev/null | grep -q . && die "network route present: run under unshare -Urn"
(cd $ST && sha256sum -c --quiet SHA256SUMS) || die "r2 stage != SHA256SUMS"
(cd $R1S && sha256sum -c --quiet SHA256SUMS) && cmp -s $R1S/SHA256SUMS $ST/inputs/r1-SHA256SUMS || die "r1 stage changed"
(cd $WS/r3 && sha256sum -c --quiet SHA256SUMS) || die "writer r3 changed"
R1=$(cat $R1S/FINAL-TREE); R2=$(cat $ST/FINAL-TREE)
G=$OUT/git; git init -q --bare $G && { cat $ST/git/objects/info/alternates; echo $ST/git/objects; } > $G/objects/info/alternates || die "private git"
GIT=(git --git-dir=$G)
tree_of() { local dir=$1 idx=$OUT/idx.$RANDOM; GIT_INDEX_FILE=$idx "${GIT[@]}" read-tree $HEAD && (cd $dir && GIT_INDEX_FILE=$idx "${GIT[@]}" --work-tree=$dir add -A -f . >/dev/null) && GIT_INDEX_FILE=$idx "${GIT[@]}" write-tree; rm -f $idx; }
mkdir -p $OUT/rb/a $OUT/rb/b
"${GIT[@]}" archive $HEAD | tar -x -C $OUT/rb/a && (cd $OUT/rb/a && git apply --whitespace=nowarn $ST/patches/final-consumer-r2-vs-64156.patch) || die "base + r2 patch"
"${GIT[@]}" archive $R1 | tar -x -C $OUT/rb/b && (cd $OUT/rb/b && git apply --whitespace=nowarn $ST/patches/relay-reader-vs-r1.patch) || die "r1 + relay-reader patch"
TA=$(tree_of $OUT/rb/a); TB=$(tree_of $OUT/rb/b); rm -rf $OUT/rb
[ "$TA" = $R2 ] && [ "$TB" = $R2 ] || die "r2 tree does not reproduce ($TA, $TB, recorded $R2)"
while read -r b f; do [ "$("${GIT[@]}" rev-parse $R2:$f)" = $b ] || die "blob of $f"; done < $ST/R2-BLOBS.txt
[ "$("${GIT[@]}" diff --name-only $R1 $R2 | sort)" = "$(printf '%s\n' .gitignore relay/api-relay.js relay/build-derived-reader-runtime.mjs relay/deploy.sh relay/derived-reader-runtime.mjs test/relay-derived-reader-runtime.test.mjs)" ] || die "r1 -> r2 touches more than the 6 relay-reader files"
echo "r2 tree $R2 reproduced" > $L/compose.txt
[ "$(git -C $T rev-parse HEAD)" = $HEAD ] && [ -z "$(git -C $T status --porcelain --untracked-files=no)" ] || die "candidate checkout is not a clean 64156dcd"
[ "$(sha256sum < $T/package-lock.json | cut -c1-64)" = $LOCK ] && grep -q '"version": "2.53.1"' $T/node_modules/viem/package.json || die "node_modules identity"
export PATH=/home/steven/.foundry/bin:/usr/bin:/bin HOME=$OUT/tmp TMPDIR=$OUT/tmp TEST_TMP=$OUT/tmp FOUNDRY_OFFLINE=true
[ "$(sha256sum < "$(command -v anvil)" | cut -c1-64)" = 10c1c727d6c1de973aeb160e59875b9a9a23464d6e74149ee8abb30b3500311b ] || die "anvil is not the pinned one"
PRISTINE=$R1; [ $MODE = relay ] && PRISTINE=$HEAD
for side in pristine r2; do src=$PRISTINE; [ $side = r2 ] && src=$R2
  mkdir -p $OUT/$side && "${GIT[@]}" archive $src | tar -x -C $OUT/$side || die "export $side"
  ln -s $T/node_modules $OUT/$side/node_modules; ln -s $T/network/node_modules $OUT/$side/network/node_modules; ln -s $T/relay/node_modules $OUT/$side/relay/node_modules
  (cd $OUT/$side && timeout -k 10 600 node relay/build-network.mjs < /dev/null) > $L/build-network--$side.out 2>&1 || die "build-network ($side)"
done
cmp -s $OUT/pristine/relay/network-runtime.bundle.mjs $OUT/r2/relay/network-runtime.bundle.mjs || die "the shared network runtime bundle changed"
sha256sum $OUT/r2/relay/network-runtime.bundle.mjs | cut -c1-64 > $L/network-runtime.sha256
run() { local side=$1 f=$2 n; n=$side--$(basename $f .mjs)
  (cd $OUT/$side && timeout -k 10 900 node --test --test-reporter=tap --test-concurrency=1 --test-timeout=600000 $f < /dev/null) > $L/$n.tap 2>&1; echo $? > $L/$n.rc; }
BOOK=ADDRESS_BOOK_ADDRESS=0x7777777777777777777777777777777777777777
startup() { local name=$1 want=$2; shift 2
  (cd $OUT/r2/relay && env -i PATH=$PATH HOME=$OUT/tmp API_RELAY_PORT=0 $BOOK "$@" timeout -k 5 90 node api-relay.js) > $L/startup-$name.txt 2>&1; local rc=$?
  if [ $rc = 1 ] && grep -q "fatal: writer authority: .*$want" $L/startup-$name.txt; then echo "startup $name: OK"; else echo "startup $name: FAIL (rc $rc)"; fi; }

if [ $MODE = relay-reader ]; then
  for side in pristine r2; do
    (cd $OUT/$side && timeout -k 10 900 node scripts/build-host-service-packages.mjs --check < /dev/null) > $L/host-packages-check--$side.out 2>&1; echo $? > $L/host-packages-check--$side.rc
    (cd $OUT/$side && timeout -k 10 900 node scripts/build-mcp-guest-bundle.mjs --check < /dev/null) > $L/mcp-bundle-check--$side.out 2>&1; echo $? > $L/mcp-bundle-check--$side.rc
  done
  # CONTROL: before the release step builds the derived runtime, the derived selector refuses explicitly ("not composed")
  startup absent-runtime "not composed" ENCLAVE_CHAIN_AUTHORITY=verifier ENCLAVE_CHAIN_VERIFIER=http://127.0.0.1:9 ENCLAVE_WRITER_AUTHORITY_SOURCE=derived \
    ENCLAVE_DERIVED_READER_CONFIG=/nonexistent/r.json ENCLAVE_DERIVED_ANCHOR_JOURNAL=/nonexistent/j.json > $L/startup-control.txt
  # the release prerequisite (relay/deploy.sh runs it after build-network.mjs)
  (cd $OUT/r2/relay && timeout -k 10 600 node build-derived-reader-runtime.mjs < /dev/null) > $L/build-derived-reader-runtime.out 2>&1 || die "build-derived-reader-runtime"
  (cd $OUT/r2/relay && sha256sum derived-reader-runtime.bundle.mjs derived-reader-runtime.bundle.mjs.manifest.json schedule_reader.mjs) > $OUT/RELAY-READER-RUNTIME.sha256
  run r2 test/relay-derived-reader-runtime.test.mjs
  { startup no-verifier "needs the relay's verifier authority" ENCLAVE_WRITER_AUTHORITY_SOURCE=derived ENCLAVE_DERIVED_READER_CONFIG=/nonexistent/r.json ENCLAVE_DERIVED_ANCHOR_JOURNAL=/nonexistent/j.json
    startup bad-value 'must be "derived" or unset' ENCLAVE_WRITER_AUTHORITY_SOURCE=quorum
    startup url-config "absolute file path" ENCLAVE_CHAIN_AUTHORITY=verifier ENCLAVE_CHAIN_VERIFIER=http://127.0.0.1:9 ENCLAVE_WRITER_AUTHORITY_SOURCE=derived ENCLAVE_DERIVED_READER_CONFIG=http://127.0.0.1:9/reader ENCLAVE_DERIVED_ANCHOR_JOURNAL=/nonexistent/j.json; } > $L/startup.txt
  for c in EnclaveDeployments EnclaveAddressBook; do mkdir -p $OUT/r2/contracts/foundry/out/$c.sol && cp $T/contracts/foundry/out/$c.sol/$c.json $OUT/r2/contracts/foundry/out/$c.sol/ || die "abi $c"; done
  (cd $OUT/r2 && KVM_TREE=$OUT/r2 timeout -k 5 600 node --test --test-reporter=tap --test-concurrency=1 test/derived-writer-authority.test.mjs test/derived-writer-authority-abi.test.mjs test/derived-writer-authority-kvm-store.test.mjs < /dev/null) > $L/writer.tap 2>&1; echo $? > $L/writer.rc
  run pristine test/relay-deploy-closure.test.mjs; run r2 test/relay-deploy-closure.test.mjs
  # the measured platform-api guest bundle: stale on r2 (api-relay.js), regenerated, --check passes, and no reader inside it
  (cd $OUT/r2 && timeout -k 10 900 node scripts/build-platform-api-guest-bundle.mjs --check < /dev/null) > $L/platform-api-check--before.out 2>&1; echo $? > $L/platform-api-check--before.rc
  (cd $OUT/r2 && timeout -k 10 900 node scripts/build-platform-api-guest-bundle.mjs < /dev/null) > $L/platform-api-regenerate.out 2>&1 || die "platform-api regeneration"
  (cd $OUT/r2 && timeout -k 10 900 node scripts/build-platform-api-guest-bundle.mjs --check < /dev/null) > $L/platform-api-check--after.out 2>&1; echo $? > $L/platform-api-check--after.rc
  mkdir -p $OUT/release && cp $OUT/r2/metal/guest/platform-api.bundle.mjs $OUT/r2/metal/guest/platform-api.bundle.mjs.manifest.json $OUT/r2/relay/derived-reader-runtime.bundle.mjs \
    $OUT/r2/relay/derived-reader-runtime.bundle.mjs.manifest.json $OUT/r2/relay/schedule_reader.mjs $OUT/release/ && (cd $OUT/release && sha256sum *) > $OUT/RELEASE.sha256
fi
if [ $MODE = relay ]; then
  OT=$P/offchain-registration-fixture-stage/runs/20261026T040819Z-831175/tree/contracts/foundry; RM=$P/rig-artifact-closure-stage/r2/run/20261026T034813Z/ARTIFACTS-after-final.sha256
  for side in pristine r2; do
    mkdir -p $OUT/$side/contracts/foundry/out && (cd $OT && find out -type f -not -path 'out/build-info/*' -print0 | xargs -0 cp --parents -t $OUT/$side/contracts/foundry/) || die "artifact copy $side"
    diff <(grep -v build-info $RM | LC_ALL=C sort -k2) <(cd $OUT/$side/contracts/foundry && find out -type f | LC_ALL=C sort | xargs sha256sum | LC_ALL=C sort -k2) > $L/artifacts--$side.diff || die "artifacts ($side)"
  done
  (cd $OUT/r2/relay && timeout -k 10 600 node build-derived-reader-runtime.mjs < /dev/null) > $L/build-derived-reader-runtime.out 2>&1 || die "build-derived-reader-runtime"
  (cd $OUT/r2 && timeout -k 10 900 node scripts/build-platform-api-guest-bundle.mjs < /dev/null) > $L/platform-api-regenerate.out 2>&1 || die "platform-api regeneration"
  for f in test/native-relay-chain-authority.test.mjs test/platform-api-admin-cli.test.mjs test/platform-api-admin-status.test.mjs test/platform-api-forward.test.mjs \
           test/platform-api-handoff-production.test.mjs test/platform-api-hosted.test.mjs test/platform-api-native-issuer.test.mjs test/relay-chain-consumers.test.mjs; do
    run pristine $f; run r2 $f; done
fi

python3 -I - "$L" "$MODE" "$P/rpc-final-candidate-20261026/TESTS.tsv" "$OUT" <<'PY' > $OUT/verdict.json; rc=$?
import json, re, sys, pathlib
L, mode, tsv, OUT = pathlib.Path(sys.argv[1]), sys.argv[2], sys.argv[3], pathlib.Path(sys.argv[4])
def counts(name):
    s = (L / f"{name}.tap").read_text(errors="replace"); r = int((L / f"{name}.rc").read_text())
    return {"rc": r, **{k: int(m.group(1)) for k in ("tests", "pass", "fail", "skipped", "todo", "cancelled") for m in [re.search(rf"^# {k} (\d+)$", s, re.M)] if m}}
clean = lambda c, n=None: c["rc"] == 0 and c.get("tests", 0) > 0 and c.get("pass") == c.get("tests") and (n is None or c.get("tests") == n) and not any(c.get(k) for k in ("fail", "skipped", "todo", "cancelled"))
rcf = lambda n: int((L / f"{n}.rc").read_text())
def same(f):
    a, b = counts(f"pristine--{f}"), counts(f"r2--{f}")
    return {"pristine": a, "r2": b, "same": all(a.get(k) == b.get(k) for k in ("tests", "pass", "fail", "skipped", "todo", "cancelled")) and a["rc"] == b["rc"], "r2Clean": clean(b)}
out, ok = {"mode": mode, "networkRuntimeBundleUnchanged": True, "networkRuntimeSha256": (L / "network-runtime.sha256").read_text().strip()}, True
if mode == "relay-reader":
    st = {k: {s: rcf(f"{k}--{s}") for s in ("pristine", "r2")} for k in ("host-packages-check", "mcp-bundle-check")}
    out["committedGeneratedArtifacts"] = st; ok = ok and all(v["pristine"] == v["r2"] for v in st.values())
    ctl = (L / "startup-control.txt").read_text(); out["controlAbsentRuntime"] = ctl.strip(); ok = ok and ctl.strip() == "startup absent-runtime: OK"
    t = counts("r2--relay-derived-reader-runtime.test"); out["relayReaderTest"] = t; ok = ok and clean(t, 3)
    su = (L / "startup.txt").read_text(); out["writerStartup"] = {"ok": su.count(": OK"), "fail": su.count(": FAIL")}; ok = ok and su.count(": OK") == 3 and ": FAIL" not in su
    w = counts("writer"); out["writer"] = w; ok = ok and clean(w, 23)
    d = same("relay-deploy-closure.test"); out["relayDeployClosure"] = d; ok = ok and d["same"] and d["r2Clean"]
    before, after = rcf("platform-api-check--before"), rcf("platform-api-check--after")
    man = json.loads((OUT / "release" / "platform-api.bundle.mjs.manifest.json").read_text())
    readerInGuest = sorted(i for i in man["inputs"] if i.startswith("network/derived-reader/") or i == "relay/derived-reader-runtime.mjs")
    rel = {l.split()[1]: l.split()[0] for l in (OUT / "RELEASE.sha256").read_text().splitlines() if l.strip()}
    out["platformApiGuestBundle"] = {"staleBefore": before != 0, "checkAfterRegeneration": after, "readerModulesInGuest": readerInGuest, "sha256": rel.get("platform-api.bundle.mjs"), "manifestSha256": rel.get("platform-api.bundle.mjs.manifest.json")}
    ok = ok and before != 0 and after == 0 and not readerInGuest
    out["relayReaderRuntime"] = {k: rel.get(k) for k in ("derived-reader-runtime.bundle.mjs", "derived-reader-runtime.bundle.mjs.manifest.json", "schedule_reader.mjs")}
    ok = ok and rel.get("schedule_reader.mjs") == "688b7a1f09c898f66cc7b92473a9fbda042402ef833bb983ff794e5f07128fb0"
if mode == "relay":
    want = {l.split("\t")[0]: l.split("\t")[1] for l in open(tsv) if l.startswith("test/")}
    out["relayTests"] = {}
    for f in ("native-relay-chain-authority", "platform-api-admin-cli", "platform-api-admin-status", "platform-api-forward", "platform-api-handoff-production",
              "platform-api-hosted", "platform-api-native-issuer", "relay-chain-consumers"):
        r = same(f + ".test"); e = want.get(f"test/{f}.test.mjs", "-"); r["expected"] = e
        good = r["same"] and r["r2Clean"] and (e == "-" or r["r2"].get("tests") == int(e)); r["ok"] = good; out["relayTests"][f] = r; ok = ok and good
out["ok"] = ok
out["scope"] = "relay reader COMPOSITION only: KVM's committed reader loads in the relay; no derived anchor, no fresh-state authority, writer derived mode not available (120 s ceiling vs L1-finalized anchors)"
print(json.dumps(out, indent=1)); sys.exit(0 if ok else 1)
PY
(cd $ST && sha256sum -c --quiet SHA256SUMS) || { echo "## stage files changed during the run"; rc=1; }
rm -rf $OUT/pristine $OUT/r2 $OUT/tmp $OUT/git
cat $OUT/verdict.json; echo "## outputs: $OUT"; echo "## relay-reader-r2 $MODE rc=$rc"; exit $rc
