#!/usr/bin/env bash
# FOCUSED (root R5): only what changed - helper unit tests, the parse of every PowerShell text, and the D1 composition on
# mirror-new (exact live control + composed candidate: root's host 0c82e9ba + writer 0fa7678f, bundle 6bef372d)
set -uo pipefail
P=/home/steven/Documents/Codex/2026-10-18/wo/work/node-hold-package-20261021; cd $P/mirror-new
echo "######## helper unit tests"; timeout 300 python3 -m unittest -v $P/helper/test_root_node_hold.py 2>&1 | grep -E "\.\.\. |^Ran|^OK|FAILED"
echo "######## parse"; timeout 600 python3 $P/tools/parse-all.py; echo "parse rc=$?"
echo "######## D1 composition"
echo "pins: host $(sha256sum windows/node/host.mjs | cut -c1-8) writer $(sha256sum network/wallet-admission.mjs | cut -c1-8) bundle $(sha256sum windows/node/host-admission.bundle.mjs | cut -c1-8) privacy-bundle $(sha256sum $P/build/out/candidate/privacy-agent.mjs | cut -c1-8) hold-test $(sha256sum test/windows-node-wallet-network-hold.test.mjs | cut -c1-8)"
one(){ name=$1; shift; r=$(timeout 240 env "$@" 2>&1); rc=$?; echo "$name rc=$rc pass=$(grep -c '^ok ' <<<"$r") fail=$(grep -c '^not ok ' <<<"$r") $(grep '^not ok ' <<<"$r" | head -5 | tr '\n' '|')"; }
T="node --test --test-concurrency=1 --test-reporter=tap"
one hold-src                  $T test/windows-node-wallet-network-hold.test.mjs
one hold-BUNDLE               PRIVACY_AGENT_MODULE=$P/build/out/candidate/privacy-agent.mjs $T test/windows-node-wallet-network-hold.test.mjs
one writer-retry-7d           $T test/wallet-admission-commit-retry-7d.test.mjs
one wallet-network-admission  $T test/wallet-network-admission.test.mjs
one hold-review-root          $T test/hold-review.test.mjs
one host-hold-review-7d       $T test/host-hold-review-7d.test.mjs
one appzone-hold              $T test/windows-node-appzone-wallet-hold.test.mjs
one wallet-enroll             $T test/windows-node-wallet-enroll.test.mjs
one admission-BUNDLE          ADMISSION_BUNDLE_TEST=1 $T test/host-admission-runtime.test.mjs
sha256sum $P/helper/root-node-hold.py $P/helper/node-hold-cutover.ps1
