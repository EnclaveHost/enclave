#!/usr/bin/env bash
# Rollback to the S1 budget 16384/8: the pre-64g unit back, one restart, checked.
set -euo pipefail; source ~/enclave-bench/pool-rollout-20260925/lib.sh
BAK=$EV/secret/enclave-guestd.service.bak-pre-64g
# enclave-99: back to 16384/8 is a simple step ONLY while the 3 canaries alone run (a guest admitted under 64 GiB may not
# fit 16 GiB). The same gate as the S2 dist rollback: chain AND guestd show no non-canary, a failed read is unsafe;
# OVERRIDE=<reason> is logged. (The apply's own immediate fail() runs with the canaries alone, so it passes this gate.)
if ! noncanary_empty; then
  [ -n "${OVERRIDE:-}" ] || { say "REFUSING the budget rollback: a non-canary deployment is (or may be) on metal-iso0; escalate to Codex"; exit 30; }
  say "NON-CANARY OVERRIDE (budget rollback): $OVERRIDE" | tee -a $EV/rollback-override.log
fi
[ -f "$BAK" ] || { say "no $BAK"; exit 1; }
grep -q -- "-guest-mem-mib 16384 -guest-cpus 8\$" "$BAK" || { say "the backup is not the 16384/8 unit"; exit 1; }
cp -p "$BAK" "$U.new" && mv "$U.new" "$U"
say "BUDGET64 ROLLBACK: daemon-reload + restart to 16384/8"
systemctl --user daemon-reload
systemctl --user restart enclave-guestd.service
wait_for 240 check_guestd pool || { say "ROLLBACK CHECK FAILED: guestd not back at 16384/800 with the 3 canaries"; exit 21; }
[ "$(systemctl --user show enclave-guestd.service -p NRestarts --value)" = 0 ] || { say "ROLLBACK CHECK FAILED: restarts"; exit 21; }
wait_for 120 public_ok || { say "ROLLBACK CHECK FAILED: canaries"; exit 21; }
mv "$BAK" "$BAK.used-$(date -u +%Y%m%dT%H%M%SZ)"; say "BUDGET64 ROLLED BACK to 16384/8 and checked"
