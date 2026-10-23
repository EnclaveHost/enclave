#!/usr/bin/env bash
# j6: (B) network-consumer-bundle, run as its own process (no separate test-runner parent: j5 was guard-stopped at 528 MiB
# with esbuild 332 + three node processes); (C) j4-diag38.sh, candidate and baseline once each.
set -uo pipefail
W=/home/steven/Documents/Codex/2026-10-18/wo/work/privacy-startup-cancellation-20261023
export TMPDIR=$W/tmp
cd $W/repo
echo "=== B network-consumer-bundle at $(git rev-parse HEAD)"
timeout -k 5 600 node test/network-consumer-bundle.test.mjs; b=$?
echo "=== B rc=$b"
echo "=== C diag38"
$W/j4-diag38.sh
[ "$b" -eq 0 ]
