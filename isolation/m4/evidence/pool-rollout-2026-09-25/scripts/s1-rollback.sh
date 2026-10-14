#!/usr/bin/env bash
# S1 rollback: the S0 unit (old binary, no flags) back, then checks. The old binary was never touched.
set -euo pipefail; source ~/enclave-bench/pool-rollout-20260925/lib.sh
OLD_LINE=$(cat $EV/s0-baseline/guestd-unit-execstart.line)
[ -f "$UBAK" ] || { say "no $UBAK"; exit 1; }
grep -Fxq "$OLD_LINE" "$UBAK" || { say "the backup is not the S0 unit"; exit 1; }
cp -p "$UBAK" "$U.new" && mv "$U.new" "$U"
say "S1 ROLLBACK: daemon-reload + restart"
systemctl --user daemon-reload
systemctl --user restart enclave-guestd.service
systemctl --user show enclave-guestd.service -p ExecStart --value | grep -Fq "path=$PROD/bin/guestd ;" || { say "ROLLBACK CHECK FAILED: ExecStart"; exit 21; }
wait_for 240 check_guestd nopool || { say "ROLLBACK CHECK FAILED: guestd not back in its S0 state"; exit 21; }
[ "$(systemctl --user show enclave-guestd.service -p NRestarts --value)" = 0 ] || { say "ROLLBACK CHECK FAILED: restarts"; exit 21; }
mv "$UBAK" "$UBAK.used-$(date -u +%Y%m%dT%H%M%SZ)"; say "S1 ROLLED BACK and checked"
