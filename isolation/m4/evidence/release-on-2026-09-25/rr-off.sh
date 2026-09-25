#!/usr/bin/env bash
# Step 2's rollback by hand: relay-release-off.sh (fef9905f, line-wise: the five lines out, every other line kept and
# reported by key name) as root on nan, then release-status 503 for the canaries, metal-iso0 serving, canaries 200.
# Run DETACHED via rr-run.sh off. Fail-closed: a running release guest keeps its config until relaunched.
set -euo pipefail; source ~/enclave-bench/pool-rollout-20260925/lib.sh; source ~/enclave-bench/s4c-20260925/lib4cc.sh; source ~/enclave-bench/release-on-20260925/lib-ro.sh
trap '' HUP PIPE
grep -qE '^0::/.*/rr-off-apply-[0-9]{8}T[0-9]{6}Z\.service$' /proc/self/cgroup || { say "REFUSING: run it detached, through rr-run.sh off"; exit 2; }
[ "$(local_sha $OFF_SH)" = "$OFF_SHA" ] || { say "REFUSING: the local relay-release-off.sh is not fef9905f"; exit 2; }
say "release-off: running relay-release-off.sh (fef9905f) as root on nan (one api-relay restart)"
set +e; nan_run $OFF_SH $OFF_SHA > $RO/off-output.txt 2>&1; rc=$?; set -e
[ $rc = 0 ] || { say "release-off: relay-release-off.sh exited $rc (off-output.txt); rc 2 = refused, nothing changed"; exit 3; }
wait_for 180 relay_row_ok || { say "release-off CHECK FAILED: metal-iso0 not serving/eligible"; exit 21; }
wait_for 300 public_ok || { say "release-off CHECK FAILED: canaries"; exit 21; }
for id in $CAN; do [ "$(rstat_code $id)" = 503 ] || { say "release-off CHECK FAILED: ${id:0:10} is not 503"; exit 21; }; done
say "RELEASE OFF (line-wise) and checked: release-status 503, metal-iso0 serving, canaries 200"
