#!/bin/sh
# Linux lease activation, units: the conduit bundle generated then checked current (and the existing host-admission bundles
# unchanged), every metal launcher/guest/builder suite incl. the new conduit test, the Python overlay builder's test.
# Suites that read git history use main's .git read-only (this tree has none; HEAD = main's e762a9c5).
set -e
W=/home/steven/Documents/Codex/2026-10-18/wo/work; T=$W/linux-lease-activation/tree
cd $T
node scripts/build-metal-lease-gas.mjs
node scripts/build-metal-lease-gas.mjs --check
(node scripts/build-host-admission.mjs --check && echo HOST-ADMISSION-BUNDLE-CURRENT) || echo "PRE-EXISTING: main host-admission bundle stale (not an input of this work)"
echo BUNDLES-OK
export GIT_DIR=$W/enclave/.git GIT_WORK_TREE=$T GIT_OPTIONAL_LOCKS=0
node --test --test-concurrency=1 test/metal-lease-gas-conduit.test.mjs test/metal-launcher-isolation.test.mjs test/metal-launcher-certs.test.mjs \
  test/metal-measured-control.test.mjs test/metal-host-policy.test.mjs test/metal-shielded-build.test.mjs test/metal-update.test.mjs \
  test/metal-agent.test.mjs test/metal-agent-pads.test.mjs test/shielded-multi-card.test.mjs test/custody-direct-host.test.mjs test/tenant-compute-eligibility.test.mjs
echo JS-METAL-OK
python3 test/metal-control-overlay.test.py -v 2>&1
echo PY-OVERLAY-OK
