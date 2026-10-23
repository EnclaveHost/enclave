#!/usr/bin/env bash
# j2: existing suites coupled to the changed files (privacy-agent.mjs, entries/privacy-agent.mjs), once each, unchanged,
# on the candidate: unit (config, proofs, host-service lifecycle/transport), daemon (host-services carriers + cold start,
# which also bundles the entry), consumer bundle, canary
set -euo pipefail
W=/home/steven/Documents/Codex/2026-10-18/wo/work/privacy-startup-cancellation-20261023
export TMPDIR=$W/tmp; mkdir -p "$TMPDIR"
cd $W/repo
timeout -k 5 1500 node --test --test-concurrency=1 --test-force-exit --test-timeout=300000 \
  test/privacy-agent-config.test.mjs test/privacy-agent-proofs.test.mjs test/host-service-lifecycle.test.mjs \
  test/host-service-transport.test.mjs test/host-services-carriers.test.mjs test/host-services-cold-start.test.mjs \
  test/network-consumer-bundle.test.mjs test/provider-canary-independent.test.mjs
