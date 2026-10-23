#!/usr/bin/env bash
# rerun only the given suites (no package rebuild: the packages are unchanged since the last build-and-test), pinned binaries
set -uo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
BIN="$HERE/../resume-after-checkpoint-20261022/rpc-runtime-final-integration/bin"
(cd "$BIN" && sha256sum -c --quiet PINS.sha256) || exit 5
sha256sum "$HERE/repo/network/host-services/packages/public-rpc.package.json"
export RETH_BIN="$BIN/reth-v2.8.0" HELIOS_BASE_BIN="$BIN/helios-eeffcc9" WITNESS_CHECK_BIN="$BIN/witness-check" CONSUMERS="$HERE/consumers"
STRICT=1 JOB_SEC=${JOB_SEC:-600} exec bash "$HERE/jobs/job.sh" "$@"
