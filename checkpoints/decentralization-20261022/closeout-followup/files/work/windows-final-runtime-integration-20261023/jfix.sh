#!/usr/bin/env bash
# Follow-ups to J2/J3: build the host-service packages (gitignored output the role suites need; 8 skips), rerun those
# suites, host-services-carriers (failed), service-index (historical registry now from the in-tree rewritten fixture),
# the stage suite (its 2 cases need the external Linux stage-1 archive: allowed, reported skips), the manager test that
# imports apptls (TLS-coupled, missing from J1); then classify site-independent-account-startup on the prior final
# 1f19ad15 with ONLY the offline Safe fixture added (base-fx).
set -uo pipefail
H=/home/steven/Documents/Codex/2026-10-18/wo/work/windows-final-runtime-integration-20261023; cd "$H/candidate"; rc=0
PATH="$H/stubs:/usr/local/bin:/usr/bin:/bin" timeout -k 10 600 unshare -rn sh -c 'node scripts/build-host-service-packages.mjs | tail -2 && node scripts/build-host-service-packages.mjs --check | tail -1' || exit 9
cd "$H"
./run-suite.py jfix-roles -- test/host-service-verifier-roles.test.mjs test/hosted-policy-cold-start.test.mjs test/host-services-carriers.test.mjs \
  test/service-index.test.mjs windows/vbslike/manager/ops/multi-accept.test.mjs || rc=1
./run-suite.py jfix-stage --allow-skip 2 -- test/hosted-services-stage.test.mjs || rc=1
./run-suite.py jfix-startup-control --tree "$H/base-fx" -- test/site-independent-account-startup.test.mjs && echo "[jfix] control PASSES" || echo "[jfix] control fails too"
echo "[jfix] rc=$rc"; exit $rc
