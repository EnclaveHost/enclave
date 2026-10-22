#!/usr/bin/env bash
# ONE queued job (768 MiB: Kubo + Caddy + node stubs). Unit tests of the block extractor, then the end-to-end proof in a
# loopback-only network namespace (no internet; nothing touches production).
set -uo pipefail
cd "$(dirname "$0")"
PKG=/home/steven/Documents/Codex/2026-10-18/wo/work/control-vm/missing-pin-package/sites/bafybeieuxt6vy424gnmtb5eo6mey6x5p5xbu2mpr4xkiwvz25cbeotzaou
echo "package site.car sha256 $(sha256sum "$PKG/site.car" | cut -c1-64) ($(stat -c%s "$PKG/site.car") bytes)"
PKG="$PKG" node --test --test-concurrency=1 test/extract.test.mjs; unit=$?
unshare -rn bash -c "ip link set lo up && bash e2e/run-e2e.sh '$PKG'"; e2e=$?
rm -rf run-unit
echo "unit-rc=$unit e2e-rc=$e2e"
[ $unit = 0 ] && [ $e2e = 0 ] && echo SERVING-JOB-OK
