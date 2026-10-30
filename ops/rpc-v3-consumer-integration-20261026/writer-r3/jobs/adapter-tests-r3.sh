#!/bin/bash
# finalized-writer-integration-stage r3: the FROZEN r2 adapter + patch (r2 SHA256SUMS fab96a8f; patch eb804950, applies to 64156dcd;
# fixed 120 s ceiling, no override) qualified against KVM's COMMITTED reader 34a3c0d6d4c5 instead of its mutable working tree:
# the reader closure (network/derived-reader/**, lifecycle-finality-bridge, deployment-lifecycle-journal, deployment-restart-policy;
# r3/KVM-34a3-CLOSURE.blobs) is exported from the commit's blobs (git archive) into the private 64156dcd + r2-patch copy; every base
# module it imports is required blob-identical in 64156dcd and 34a3. Then: node --check, EXACTLY 23 tests (16 adapter, 2 ABI,
# 5 over the committed coverage store), the API-composition check (relay selector -> committed startDerivedLifecycleReader), and
# the 5 real api-relay.js startup checks. Derived writing stays NOT enabled (finalized freshness cannot meet 120 s).
# ROOT launches it (foreground; nothing is left running):
#   jobs/q-exit-status.sh <name> 512 unshare -Urn bash finalized-writer-integration-stage/r3/jobs/adapter-tests-r3.sh
set -uo pipefail
export PATH=/usr/bin:/bin
P=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025
T=$P/rpc-final-candidate-20261026/tree; S1=$P/finalized-writer-integration-stage; S2=$S1/r2; S=$S1/r3
KC=34a3c0d6d4c5aebffffb2492437487c9de74fb66
KVM=/home/steven/Documents/Codex/2026-10-23/it/work/enclave-deployment-lifecycle
HEAD=64156dcd91ff1e769e74f9c26a846be19254c716
O=$S/runs/run-$(date -u +%Y%m%dT%H%M%SZ)-$$
die() { echo "## SETUP: $*" | tee -a $O/setup.txt; echo "## adapter-tests rc=9"; exit 9; }
mkdir -p $O/tmp || exit 9
ip link set lo up 2>/dev/null; ip -4 route 2>/dev/null | grep -q . && die "IPv4 route present: run under unshare -Urn"
[ "$(sha256sum < $S1/SHA256SUMS | cut -c1-64)" = beb4ec4afa45875499cc4be94fe2cd985a55587881dc62798fdc189b26ac2129 ] || die "r1 SHA256SUMS is not the frozen beb4ec4a"
(cd $S1 && sha256sum -c --quiet SHA256SUMS) || die "r1 stage files changed (r1 is frozen)"
[ "$(sha256sum < $S2/SHA256SUMS | cut -c1-64)" = fab96a8f0743352f2f32a55c42ab7d6ea5b38330c5d9203c97d45b6c9c60f5b2 ] || die "r2 SHA256SUMS is not the frozen fab96a8f"
(cd $S2 && sha256sum -c --quiet SHA256SUMS) || die "r2 stage files changed (r2 is frozen)"
(cd $S && sha256sum -c --quiet SHA256SUMS) || die "r3 != its SHA256SUMS"
git -C $KVM cat-file -e $KC^{commit} 2>/dev/null || die "KVM commit $KC not present"
git -C $KVM ls-tree -r $KC network/derived-reader network/lifecycle-finality-bridge.mjs network/deployment-lifecycle-journal.mjs \
  network/deployment-restart-policy.mjs | awk '{print $3"  "$4}' | cmp -s - $S/KVM-34a3-CLOSURE.blobs || die "34a3 reader closure != KVM-34a3-CLOSURE.blobs"
[ "$(git -C $T rev-parse HEAD)" = $HEAD ] || die "candidate HEAD is not $HEAD"
R=$O/repo; mkdir -p $R
git -C $T archive $HEAD | tar -x -C $R || die "archive"                     # whole tree: relay symlinks reach ../net-guard.mjs etc.
git -C $T archive $HEAD | tar -d -C $R > /dev/null 2>&1 || die "copy != $HEAD"
# the relay's network runtime bundle is a GENERATED, git-ignored file: the candidate tree's own copy is used (sha recorded)
cp $T/relay/network-runtime.bundle.mjs $T/relay/network-runtime.bundle.mjs.manifest.json $R/relay/ || die "network runtime bundle"
sha256sum $T/relay/network-runtime.bundle.mjs $T/relay/network-runtime.bundle.mjs.manifest.json > $O/bundle.sha256
for c in EnclaveDeployments EnclaveAddressBook; do mkdir -p $R/contracts/foundry/out/$c.sol && cp $T/contracts/foundry/out/$c.sol/$c.json $R/contracts/foundry/out/$c.sol/ || die "abi $c"; done
sha256sum $T/contracts/foundry/out/EnclaveDeployments.sol/EnclaveDeployments.json $T/contracts/foundry/out/EnclaveAddressBook.sol/EnclaveAddressBook.json > $O/abi.sha256
[ "$(sha256sum < $S2/patches/finalized-writer-adapter-r2.patch | cut -c1-64)" = eb8049507ecca63a888ab142b0add15de3b13b35b223f37359004eaf342f0398 ] || die "r2 patch is not eb804950"
(cd $R && git apply --check $S2/patches/finalized-writer-adapter-r2.patch && git apply $S2/patches/finalized-writer-adapter-r2.patch) > $O/apply.txt 2>&1 || { cat $O/apply.txt; die "patch does not apply to $HEAD"; }
ln -s "$(readlink -f $T/node_modules)" $R/node_modules; ln -sfn "$(readlink -f $T/relay/node_modules)" $R/relay/node_modules
# KVM's COMMITTED reader closure, from commit blobs (never the working tree): pure additions to 64156dcd
for p in network/derived-reader network/lifecycle-finality-bridge.mjs network/deployment-lifecycle-journal.mjs network/deployment-restart-policy.mjs; do
  [ -e $R/$p ] && die "$p already exists in the 64156dcd copy (not a pure addition)"; done
git -C $KVM archive $KC network/derived-reader network/lifecycle-finality-bridge.mjs network/deployment-lifecycle-journal.mjs \
  network/deployment-restart-policy.mjs | tar -x -C $R || die "export of $KC closure"
for f in network/verified-chain.mjs network/gossip-head-source.mjs network/rpc-runtime.mjs network/lease-release-journal.mjs network/runtime-lock.mjs package.json package-lock.json; do
  [ "$(git -C $T rev-parse $HEAD:$f)" = "$(git -C $KVM rev-parse $KC:$f)" ] || die "$f differs between 64156dcd and $KC (closure not minimal)"; done
(cd $R && sha256sum -c $S/KVM-INPUTS.sha256) > $O/kvm-inputs.txt 2>&1 || die "committed coverage inputs != KVM-INPUTS.sha256"
echo "KVM commit $KC" >> $O/kvm-inputs.txt
node --check $R/relay/api-relay.js > $O/check.txt 2>&1; rc_check=$?
(cd $R && KVM_TREE=$R TEST_TMP=$O/tmp TMPDIR=$O/tmp timeout -k 5 600 node --test --test-reporter=tap --test-concurrency=1 \
  test/derived-writer-authority.test.mjs test/derived-writer-authority-abi.test.mjs test/derived-writer-authority-kvm-store.test.mjs) > $O/test.tap 2>&1; rc_test=$?
# the production entrypoint itself: the patched api-relay.js must reach the selector and stop there with the exact fatal reason.
# Every case carries the relay's own mandatory discovery setting (ADDRESS_BOOK_ADDRESS; api-relay.js:354 exits before the selector
# without it - the cause of run tests-2's three startup FAILs, kept as evidence). A test book address; nothing is contacted (no route).
BOOK=ADDRESS_BOOK_ADDRESS=0x7777777777777777777777777777777777777777
startup() { local name=$1 want=$2; shift 2
  (cd $R/relay && env -i PATH=$PATH HOME=$O/tmp API_RELAY_PORT=0 $BOOK "$@" timeout -k 5 90 node api-relay.js) > $O/startup-$name.txt 2>&1; local rc=$?
  if [ $rc = 1 ] && grep -q "fatal: writer authority: .*$want" $O/startup-$name.txt; then echo "startup $name: OK (rc 1, $want)"; else echo "startup $name: FAIL (rc $rc)"; return 1; fi; }
rc_start=0
startup no-verifier "needs the relay's verifier authority" ENCLAVE_WRITER_AUTHORITY_SOURCE=derived ENCLAVE_DERIVED_READER_CONFIG=/nonexistent/r.json \
  ENCLAVE_DERIVED_ANCHOR_JOURNAL=/nonexistent/j.json >> $O/startup.txt || rc_start=1
startup bad-value 'must be "derived" or unset' ENCLAVE_WRITER_AUTHORITY_SOURCE=quorum >> $O/startup.txt || rc_start=1
startup url-config "absolute file path" ENCLAVE_CHAIN_AUTHORITY=verifier ENCLAVE_CHAIN_VERIFIER=http://127.0.0.1:9 ENCLAVE_WRITER_AUTHORITY_SOURCE=derived \
  ENCLAVE_DERIVED_READER_CONFIG=http://127.0.0.1:9/reader ENCLAVE_DERIVED_ANCHOR_JOURNAL=/nonexistent/j.json >> $O/startup.txt || rc_start=1
startup not-composed "not composed" ENCLAVE_CHAIN_AUTHORITY=verifier ENCLAVE_CHAIN_VERIFIER=http://127.0.0.1:9 ENCLAVE_WRITER_AUTHORITY_SOURCE=derived \
  ENCLAVE_DERIVED_READER_CONFIG=/nonexistent/r.json ENCLAVE_DERIVED_ANCHOR_JOURNAL=/nonexistent/j.json >> $O/startup.txt || rc_start=1
# positive control: selector UNSET under the verifier authority keeps the existing explicit refusal and the relay starts on past it
(cd $R/relay && env -i PATH=$PATH HOME=$O/tmp API_RELAY_PORT=0 $BOOK ENCLAVE_CHAIN_AUTHORITY=verifier ENCLAVE_CHAIN_VERIFIER=http://127.0.0.1:9 \
  timeout -k 5 25 node api-relay.js) > $O/startup-unset.txt 2>&1; rc_unset=$?
if grep -q "\[lease-generation\] REFUSED under the verifier authority" $O/startup-unset.txt && ! grep -q "fatal: writer authority" $O/startup-unset.txt; then
  echo "startup unset: OK (rc $rc_unset; existing writer_authority_unproven refusal logged, no selector fatal)" >> $O/startup.txt
else echo "startup unset: FAIL (rc $rc_unset)" >> $O/startup.txt; rc_start=1; fi
cat $O/startup.txt
mkdir -p $O/tmp/api && (cd $R && timeout -k 5 120 node $S/jobs/api-composition-check.mjs $R $O/tmp/api) > $O/api-composition.txt 2>&1; rc_api=$?
cat $O/api-composition.txt | tail -3
rm -rf $R    # the private copy (~the whole tree); every receipt is in $O
python3 - "$O" "$rc_check" "$rc_test" "$rc_start" "$rc_api" <<'PY'
import json, pathlib, re, sys
o = pathlib.Path(sys.argv[1]); s = (o / "test.tap").read_text()
c = {k: int(v) for k, v in re.findall(r"^# (tests|pass|fail|cancelled|skipped|todo) (\d+)$", s, re.M)}
rc_check, rc_test, rc_start, rc_api = map(int, sys.argv[2:6])
n_start = (o / "startup.txt").read_text().count(": OK")
ok = rc_check == 0 and rc_test == 0 and rc_start == 0 and c.get("fail") == 0 and c.get("skipped") == 0 and c.get("cancelled") == 0 and c.get("tests") == 23 and c.get("pass") == 23 and n_start == 5 and rc_api == 0
r = {"ok": ok, "stage": "r3", "kvmCommit": "34a3c0d6d4c5aebffffb2492437487c9de74fb66", "apiCompositionRc": rc_api, "startupOk": n_start, "head": "64156dcd91ff1e769e74f9c26a846be19254c716", "nodeCheck": rc_check, "testRc": rc_test, "counts": c, "startupRc": rc_start,
     "bundleNote": "relay/network-runtime.bundle.mjs is the candidate tree's generated copy (bundle.sha256)", "scope": "adapter logic (fakes), ABI, the COMMITTED KVM 34a3 coverage store + API composition (fixture coverage: completeness and mainnet NOT proven here), real api-relay.js startup refusals"}
(o / "result.json").write_text(json.dumps(r, indent=2) + "\n"); print(json.dumps(r)); sys.exit(0 if ok else 1)
PY
