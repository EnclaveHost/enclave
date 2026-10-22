#!/usr/bin/env bash
# run-suite.sh <suite> <tag>: ONE test job (always launched through work/claude-test-queue.py by the caller). Suites:
#   carriers    test/node-policy-carriers.test.mjs against the CANDIDATE bundle (40e8ba71)
#   control     the same file against the INSTALLED bundle 6bef372d (old negative control: delivery tests must fail)
#   regression  existing host-admission-runtime (bundle mode), host-admission-retry, windows-node-platform-policy,
#               windows-node-wallet-network-hold against the candidate
#   process     existing platform-host-policy-process (packaged relay + ACTUAL supervisor through the mirror path) on the candidate
set -uo pipefail
P=$(cd "$(dirname "$0")/.." && pwd); S="$1"; TAG="$2"; L="$P/logs"; mkdir -p "$L"
export LIVE_BUNDLE="$(cd "$(dirname "$0")/.." && pwd)/out/live-rebuilt.host-admission.bundle.mjs" NODE_OPTIONS="--preserve-symlinks --preserve-symlinks-main" TMPDIR="$P/tmp-$TAG"; rm -rf "$TMPDIR"; mkdir -p "$TMPDIR"
case "$S" in
  carriers|regression|process) B="$P/out/candidate.host-admission.bundle.mjs"; T="$P/tree-$TAG";;
  control|process-live) B="$P/out/live-rebuilt.host-admission.bundle.mjs"; T="$P/tree-$TAG";;
  *) echo "unknown suite $S"; exit 2;;
esac
bash "$P/tools/make-testtree.sh" "$T" "$B" || exit 2
cd "$T"
case "$S" in
  carriers|control) node --test --test-timeout=200000 test/node-policy-carriers.test.mjs; rc=$?;;
  regression) ADMISSION_BUNDLE_TEST=1 node --test --test-timeout=200000 test/host-admission-retry.test.mjs test/host-admission-runtime.test.mjs test/windows-node-platform-policy.test.mjs test/windows-node-wallet-network-hold.test.mjs; rc=$?;;
  process|process-live) node --test --test-timeout=200000 test/platform-host-policy-process.test.mjs; rc=$?;;
esac
cd "$P"; rm -rf "$T" "$TMPDIR"
echo "SUITE $S rc=$rc"; exit $rc
