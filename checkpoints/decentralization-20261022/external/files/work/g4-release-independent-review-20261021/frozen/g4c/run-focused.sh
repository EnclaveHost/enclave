#!/usr/bin/env bash
# Focused composition tests (root: G4 + wallet integration only) on mirror = 605's mirror-new (exact live control + root D1
# host 0c82e9ba / writer 0fa7678f / bundle 6bef372d) + the G4 network files + the control delta (network-enroll)
set -uo pipefail
P=/home/steven/Documents/Codex/2026-10-18/wo/work/g4-network-composition-20261021; cd $P/mirror
echo "pins: host $(sha256sum windows/node/host.mjs | cut -c1-8) writer $(sha256sum network/wallet-admission.mjs | cut -c1-8) bundle $(sha256sum windows/node/host-admission.bundle.mjs | cut -c1-8) enroll $(sha256sum windows/node/network-enroll.mjs | cut -c1-8) G4-privacy-bundle $(sha256sum $P/out/g4/privacy-agent.mjs | cut -c1-8)"
one(){ name=$1; shift; r=$(timeout 300 env "$@" 2>&1); rc=$?; echo "$name rc=$rc pass=$(grep -c '^ok ' <<<"$r") fail=$(grep -c '^not ok ' <<<"$r") $(grep '^not ok ' <<<"$r" | head -5 | tr '\n' '|')"; }
T="node --test --test-concurrency=1 --test-reporter=tap"
one hold-src                  $T test/windows-node-wallet-network-hold.test.mjs
one hold-G4-BUNDLE            PRIVACY_AGENT_MODULE=$P/out/g4/privacy-agent.mjs $T test/windows-node-wallet-network-hold.test.mjs
one wallet-network-admission  $T test/wallet-network-admission.test.mjs
one hold-review-root          $T test/hold-review.test.mjs
one host-hold-review-7d       $T test/host-hold-review-7d.test.mjs
one appzone-hold              $T test/windows-node-appzone-wallet-hold.test.mjs
one wallet-enroll             $T test/windows-node-wallet-enroll.test.mjs
one network-enroll            $T test/windows-node-network-enroll.test.mjs
one challenge-enroll-NEW      $T test/windows-node-challenge-enroll.test.mjs
one challenge-front-managed   $T test/challenge-front-managed.test.mjs
one host-service-transport    $T test/host-service-transport.test.mjs
one host-service-ingress      $T test/host-service-ingress.test.mjs
one privacy-host-services     $T test/privacy-agent-host-services-start.test.mjs
