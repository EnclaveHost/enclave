#!/usr/bin/env bash
# iteration job: package rebuild + comparison, then the changed role's unit suite and the two composed consumer E2Es
set -uo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
STRICT=1 JOB_SEC=${JOB_SEC:-900} exec bash "$HERE/jobs/build-and-test.sh" test/public-rpc.test.mjs test/public-rpc-wallet-consumer.e2e.test.mjs test/public-rpc-witness-consumer.e2e.test.mjs
