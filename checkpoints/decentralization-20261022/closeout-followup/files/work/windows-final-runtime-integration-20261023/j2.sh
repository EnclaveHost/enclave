#!/usr/bin/env bash
# J2: consumers of the shared verified-chain change (A 554a251c) and of the two rebuilt bundles: verified-chain unit and
# opt-in boundary, Windows chain authority and ERC-1271 owner, admission (source and SHIPPED bundle), parity against the
# reproduced installed 6bef372d, hosted roles / carriers / cold start / lifecycle / transport / stage, service index, the
# metal bundle launcher, and the privacy-agent bundle's challenge/agent inputs. Each file alone; honest aggregation.
set -uo pipefail
H=/home/steven/Documents/Codex/2026-10-18/wo/work/windows-final-runtime-integration-20261023; cd "$H"; rc=0
./run-suite.py j2-shared -- test/verified-chain.test.mjs test/verified-chain-lifecycle.test.mjs test/verified-chain-optin-boundary.test.mjs \
  test/windows-chain-authority.test.mjs test/network-owner-verifier.test.mjs test/host-admission-policy.test.mjs test/host-admission-retry.test.mjs \
  test/host-admission-runtime.test.mjs test/platform-host-policy.test.mjs test/host-service-verifier-roles.test.mjs test/hosted-policy-cold-start.test.mjs \
  test/lease-relay-host-policy.test.mjs test/host-services-carriers.test.mjs test/host-services-cold-start.test.mjs test/host-service-lifecycle.test.mjs \
  test/host-service-transport.test.mjs test/hosted-services-stage.test.mjs test/policy-mirror-sync-race.test.mjs test/service-index.test.mjs \
  test/metal-launcher-isolation.test.mjs test/challenge-replica-host.test.mjs test/challenge-replica-supervise.test.mjs test/challenge-front-managed.test.mjs \
  test/privacy-agent-lifecycle.test.mjs test/enclave-network-host-canary.test.mjs || rc=1
ADMISSION_BUNDLE_TEST=1 ./run-suite.py j2-shipped-bundle -- test/host-admission-runtime.test.mjs || rc=1
LIVE_BUNDLE="$H/tmp/live/host-admission.bundle.mjs" ./run-suite.py j2-parity -- test/node-policy-carriers.test.mjs || rc=1
echo "[j2] rc=$rc"; exit $rc
