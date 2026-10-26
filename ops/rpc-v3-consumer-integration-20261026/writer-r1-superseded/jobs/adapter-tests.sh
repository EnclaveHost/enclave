#!/bin/bash
# finalized-writer-integration-stage: offline tests of the derived writer adapter on EXACT candidate 64156dcd + this stage's patch.
# ROOT launches it (foreground; nothing is left running):
#   jobs/q-exit-status.sh <name> 512 unshare -Urn bash finalized-writer-integration-stage/jobs/adapter-tests.sh
# Steps: pins -> private copy (git archive 64156dcd + its generated relay bundle + the compiled ABIs) -> git apply --check/apply the patch -> node --check
# api-relay.js -> 3 test files (adapter logic with fakes; ABI; the ACTUAL in-progress KVM coverage store, read-only import, sha
# recorded) -> the PATCHED api-relay.js started for real with the selector: it must stop at startup with the expected fatal line
# (no verifier authority; and with one, "not composed": the 64156dcd network-runtime bundle has no derived reader yet).
set -uo pipefail
export PATH=/usr/bin:/bin
P=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025
T=$P/rpc-final-candidate-20261026/tree; S=$P/finalized-writer-integration-stage
KVM=/home/steven/Documents/Codex/2026-10-23/it/work/enclave-deployment-lifecycle
HEAD=64156dcd91ff1e769e74f9c26a846be19254c716
O=$S/runs/run-$(date -u +%Y%m%dT%H%M%SZ)-$$
die() { echo "## SETUP: $*" | tee -a $O/setup.txt; echo "## adapter-tests rc=9"; exit 9; }
mkdir -p $O/tmp || exit 9
ip link set lo up 2>/dev/null; ip -4 route 2>/dev/null | grep -q . && die "IPv4 route present: run under unshare -Urn"
(cd $S && sha256sum -c --quiet SHA256SUMS) || die "stage != SHA256SUMS"
[ "$(git -C $T rev-parse HEAD)" = $HEAD ] || die "candidate HEAD is not $HEAD"
R=$O/repo; mkdir -p $R
git -C $T archive $HEAD | tar -x -C $R || die "archive"                     # whole tree: relay symlinks reach ../net-guard.mjs etc.
git -C $T archive $HEAD | tar -d -C $R > /dev/null 2>&1 || die "copy != $HEAD"
# the relay's network runtime bundle is a GENERATED, git-ignored file: the candidate tree's own copy is used (sha recorded)
cp $T/relay/network-runtime.bundle.mjs $T/relay/network-runtime.bundle.mjs.manifest.json $R/relay/ || die "network runtime bundle"
sha256sum $T/relay/network-runtime.bundle.mjs $T/relay/network-runtime.bundle.mjs.manifest.json > $O/bundle.sha256
for c in EnclaveDeployments EnclaveAddressBook; do mkdir -p $R/contracts/foundry/out/$c.sol && cp $T/contracts/foundry/out/$c.sol/$c.json $R/contracts/foundry/out/$c.sol/ || die "abi $c"; done
sha256sum $T/contracts/foundry/out/EnclaveDeployments.sol/EnclaveDeployments.json $T/contracts/foundry/out/EnclaveAddressBook.sol/EnclaveAddressBook.json > $O/abi.sha256
(cd $R && git apply --check $S/patches/finalized-writer-adapter.patch && git apply $S/patches/finalized-writer-adapter.patch) > $O/apply.txt 2>&1 || { cat $O/apply.txt; die "patch does not apply to $HEAD"; }
ln -s "$(readlink -f $T/node_modules)" $R/node_modules; ln -sfn "$(readlink -f $T/relay/node_modules)" $R/relay/node_modules
(cd $KVM && git rev-parse HEAD && sha256sum network/derived-reader/coverage.mjs network/derived-reader/coverage-store.mjs network/derived-reader/journal.mjs \
  network/lease-release-journal.mjs network/runtime-lock.mjs) > $O/kvm-inputs.txt 2>&1 || die "KVM coverage modules missing (R2/R3 not present)"
# KVM's R2/R3 files are IN PROGRESS (untracked at c66b087ac): the store tests are qualified against these exact bytes only
(cd $KVM && sha256sum -c --quiet $S/KVM-INPUTS.sha256) >> $O/kvm-inputs.txt 2>&1 || die "KVM in-progress coverage inputs differ from KVM-INPUTS.sha256: re-review before testing"
node --check $R/relay/api-relay.js > $O/check.txt 2>&1; rc_check=$?
(cd $R && KVM_TREE=$KVM TEST_TMP=$O/tmp TMPDIR=$O/tmp timeout -k 5 600 node --test --test-reporter=tap --test-concurrency=1 \
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
rm -rf $R    # the private copy (~the whole tree); every receipt is in $O
python3 - "$O" "$rc_check" "$rc_test" "$rc_start" <<'PY'
import json, pathlib, re, sys
o = pathlib.Path(sys.argv[1]); s = (o / "test.tap").read_text()
c = {k: int(v) for k, v in re.findall(r"^# (tests|pass|fail|cancelled|skipped|todo) (\d+)$", s, re.M)}
rc_check, rc_test, rc_start = map(int, sys.argv[2:5])
ok = rc_check == 0 and rc_test == 0 and rc_start == 0 and c.get("fail") == 0 and c.get("skipped") == 0 and c.get("cancelled") == 0 and c.get("tests", 0) == c.get("pass", -1) > 0
r = {"ok": ok, "head": "64156dcd91ff1e769e74f9c26a846be19254c716", "nodeCheck": rc_check, "testRc": rc_test, "counts": c, "startupRc": rc_start,
     "bundleNote": "relay/network-runtime.bundle.mjs is the candidate tree's generated copy (bundle.sha256)", "scope": "adapter logic (fakes), ABI, ACTUAL in-progress KVM coverage store (fixture coverage: completeness NOT proven here), real api-relay.js startup refusals"}
(o / "result.json").write_text(json.dumps(r, indent=2) + "\n"); print(json.dumps(r)); sys.exit(0 if ok else 1)
PY
