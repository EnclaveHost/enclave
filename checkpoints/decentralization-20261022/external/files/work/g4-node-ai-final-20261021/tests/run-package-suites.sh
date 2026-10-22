#!/usr/bin/env bash
# the package's own suites on mirror-new (exact live control + composed candidate), serial, each file bounded
set -uo pipefail
P=/home/steven/Documents/Codex/2026-10-18/wo/work/node-hold-package-20261021; cd $P/mirror-new
echo "pins: host $(sha256sum windows/node/host.mjs | cut -c1-8) agent $(sha256sum windows/node/agent.mjs | cut -c1-8) appzone $(sha256sum windows/node/appzone.mjs | cut -c1-8) enroll $(sha256sum windows/node/network-enroll.mjs | cut -c1-8) bundle $(sha256sum windows/node/host-admission.bundle.mjs | cut -c1-8) hvcert $(sha256sum windows/node/hvcert.mjs | cut -c1-8) wallet $(sha256sum network/wallet-admission.mjs | cut -c1-8) privacy-bundle $(sha256sum $P/build/out/candidate/privacy-agent.mjs | cut -c1-8)"
one(){ name=$1; shift; r=$(timeout 240 env "$@" 2>&1); rc=$?; echo "$name rc=$rc pass=$(grep -c '^ok ' <<<"$r") fail=$(grep -c '^not ok ' <<<"$r") $(grep '^not ok ' <<<"$r" | head -5 | tr '\n' '|')"; }
T="node --test --test-concurrency=1 --test-reporter=tap"
one hold-src                  $T test/windows-node-wallet-network-hold.test.mjs
one hold-BUNDLE               PRIVACY_AGENT_MODULE=$P/build/out/candidate/privacy-agent.mjs $T test/windows-node-wallet-network-hold.test.mjs
one appzone-hold              $T test/windows-node-appzone-wallet-hold.test.mjs
one wallet-enroll             $T test/windows-node-wallet-enroll.test.mjs
one host-hold-review-7d       $T test/host-hold-review-7d.test.mjs
one wallet-network-admission  $T test/wallet-network-admission.test.mjs
one hold-review-root          $T test/hold-review.test.mjs
one admission-BUNDLE          ADMISSION_BUNDLE_TEST=1 $T test/host-admission-runtime.test.mjs
one hvcert                    $T test/windows-node-hvcert.test.mjs
one hvcert-pending            $T test/windows-node-hvcert-pending.test.mjs
one wg-manager                $T test/wg-manager.test.mjs
one privacy-agent-lifecycle   $T test/privacy-agent-lifecycle.test.mjs
