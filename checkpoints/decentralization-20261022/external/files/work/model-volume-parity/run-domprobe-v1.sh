#!/usr/bin/env bash
# The ONE harness repaired after final-v1 (immutable; v1): isolation/m3/test-domprobe-layers.sh, which now starts domexec
# with its minimum app allocation (64 MiB) instead of the 0 MiB domexec refuses. Asserted here beyond the harness's exit:
# the positive control (both layers on the real probe) passes, and printed BEFORE the mutants; each of the three
# mutants is killed by a layer check, never by a probe that did not run ("never reported done") or did not build.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
out=$(mktemp); trap 'rm -f "$out"' EXIT
cd "$here/tree/isolation/m3"
rc=0; sh ./test-domprobe-layers.sh > "$out" 2>&1 || rc=$?
cat "$out"
[ "$rc" -eq 0 ] || { echo "run-domprobe-v1: FAIL (harness exit $rc)"; exit 1; }
pass=$(grep -n '^domprobe layers: PASS$' "$out" | cut -d: -f1)
first_mut=$(grep -n '^ok   mutant ' "$out" | head -1 | cut -d: -f1)
[ -n "$pass" ] && [ -n "$first_mut" ] && [ "$pass" -lt "$first_mut" ] || { echo "run-domprobe-v1: FAIL (no positive control before the mutants)"; exit 1; }
for w in vsock_local_domain1 vsock_local_domain2 vsock_own_control vsock_host_control; do
  grep -q "^ok   base $w=" "$out" && grep -q "^ok   filtered_$w=Operation not permitted$" "$out" || { echo "run-domprobe-v1: FAIL ($w layers)"; exit 1; }
done
grep -q '^ok   seccomp=2$' "$out" && grep -q '^ok   report=Permission denied' "$out" && grep -q '^ok   filtered_report=Permission denied' "$out" \
  || { echo "run-domprobe-v1: FAIL (seccomp/report lines)"; exit 1; }
n=$(grep -c '^ok   mutant .* killed: FAIL ' "$out")
[ "$n" -eq 3 ] || { echo "run-domprobe-v1: FAIL ($n of 3 mutants killed)"; exit 1; }
if grep '^ok   mutant ' "$out" | grep -qE 'never reported done|did not build'; then echo "run-domprobe-v1: FAIL (a mutant died without running)"; exit 1; fi
grep -q '^domprobe layers mutants: all killed$' "$out" || { echo "run-domprobe-v1: FAIL (mutant tally)"; exit 1; }
echo "run-domprobe-v1: PASS"
