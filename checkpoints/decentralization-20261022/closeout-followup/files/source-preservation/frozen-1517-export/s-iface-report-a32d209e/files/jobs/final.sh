#!/usr/bin/env bash
# final evidence on the committed tree: key scan of 36919aaf..HEAD, package rebuild + comparison (F for the five existing
# roles, S's 36919 build for public-rpc), then every suite the change affects (strict: nothing skipped)
set -uo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
cd "$HERE/repo"; echo "== scan 36919aafe..HEAD"; git log --oneline 36919aafe..HEAD; python3 .githooks/scan-crypto-keys.py --range 36919aafe..HEAD; echo "scan rc=$?"
STRICT=1 JOB_SEC=${JOB_SEC:-1800} exec bash "$HERE/jobs/build-and-test.sh" test/public-rpc.test.mjs test/public-rpc-wallet-consumer.e2e.test.mjs test/public-rpc-witness-consumer.e2e.test.mjs \
  test/public-rpc-browser.test.mjs test/host-service-verifier-roles.test.mjs test/host-service-lifecycle.test.mjs
