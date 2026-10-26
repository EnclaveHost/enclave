#!/bin/bash
set -euo pipefail
P=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025
S=$P/base-finality-proof-stage/r6-ops-fixes
(cd "$S" && sha256sum -c --quiet SHA256SUMS)
ip link set lo up
if ip -o route | grep -q .; then exit 9; fi
OUT=$S/logs/sampler-loopback-$(date -u +%Y%m%dT%H%M%SZ)-$$
mkdir -p "$OUT/readiness" "$OUT/coverage" "$OUT/tmp"
cp "$S"/tree/readiness/*.py "$OUT/readiness/"
cp "$P/coverage-stage/origin_extract.py" "$OUT/coverage/"
set +e
(cd "$OUT/readiness" && env -i PATH=/usr/bin:/bin HOME="$OUT/tmp" TMPDIR="$OUT/tmp" timeout 1200 /usr/bin/python3 -I -B test_readiness_sampler.py) > "$OUT/sampler.txt" 2>&1
rc=$?
set -e
cat "$OUT/sampler.txt"
echo "Actual sampler exit=$rc"
[ "$rc" = 0 ] && grep -q '^Ran 92 tests in ' "$OUT/sampler.txt" && grep -qx OK "$OUT/sampler.txt" && ! grep -qiE 'skipped|expected failure|unexpected success|^FAILED' "$OUT/sampler.txt"
(cd "$OUT" && sha256sum sampler.txt > RECEIPTS.sha256)
echo "Outputs: $OUT"
