#!/bin/sh
# Offline tests of the PREPARED A1 -> A2 integration (no network, no reth, no datadir). NOT run by this stage: root runs it
# under the shared queue (256 MiB), foreground. STRICT: every suite runs; the script exits 0 only if each Python suite exits 0
# and ends with a bare "OK" (no skips, no expected failures), and the node TAP log is clean per taplog.py (tests > 0,
# pass == tests, 0 fail/cancelled/skipped/todo). Per-suite logs: logs/run/<suite>.{log,rc}. Refuses to reuse logs/run.
set -u
cd "$(dirname "$0")"
export ANCHOR_DEPS_ROOT="${ANCHOR_DEPS_ROOT:-/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/relay-consumer-source}"
ip link set lo up 2>/dev/null || true
R=logs/run
if [ -e "$R" ]; then echo "REFUSED: $R exists (evidence is never overwritten)"; exit 2; fi
mkdir -p "$R"; sha256sum -c SHA256SUMS > "$R/inputs.check" 2>&1 || { echo "INPUTS DIFFER from SHA256SUMS (see $R/inputs.check)"; exit 2; }
fail=0
for s in test_a2a4 test_receipt_writer test_pinned_manifest; do
  timeout 1800 python3 -u "test/$s.py" < /dev/null > "$R/$s.log" 2>&1; rc=$?; echo $rc > "$R/$s.rc"
  last=$(grep -E '^(OK|FAILED)' "$R/$s.log" | tail -n 1)
  if [ $rc -eq 0 ] && [ "$last" = "OK" ] && ! grep -qE '^(OK|FAILED) \(' "$R/$s.log"; then echo "$s: OK"; else echo "$s: FAILED (rc=$rc, '$last')"; fail=1; fi
done
timeout 300 node --test --test-reporter=tap test/a1-gate.test.mjs < /dev/null > "$R/a1-gate.tap" 2>&1; rc=$?; echo $rc > "$R/a1-gate.rc"
if python3 taplog.py baseline "$R/a1-gate.tap" "$rc" > "$R/a1-gate.verdict.json"; then echo "a1-gate.test.mjs: clean $(cat "$R/a1-gate.verdict.json")"
else echo "a1-gate.test.mjs: NOT CLEAN $(cat "$R/a1-gate.verdict.json")"; fail=1; fi
echo "RUN-TESTS rc=$fail"; exit $fail
