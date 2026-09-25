#!/usr/bin/env bash
# 4c-a rollback: remove ONLY the 4c measurement from the one line (never a whole old file). Refused while the node runs
# or attests the 4c image (order: 4c-b's rollback first), unless FORCE_ORDER=<reason> (logged).
set -euo pipefail; source ~/enclave-bench/pool-rollout-20260925/lib.sh; source ~/enclave-bench/s4c-20260925/lib4c.sh
dist=$(python3 -c "import json;print(json.load(open('$C'))['dist'])"); read -r am _ <<<"$(node_attested)" || true
if [ "$dist" != "$OLDD" ] || [ "${am:-}" = "$NEWM" ]; then
  [ -n "${FORCE_ORDER:-}" ] || { say "REFUSING: the node still runs or attests the 4c image; roll back 4c-b first"; exit 30; }
  say "ORDER OVERRIDE: $FORCE_ORDER"; { echo "$(date -u +%FT%TZ) 4c-a ORDER OVERRIDE: $FORCE_ORDER" >> $EV/rollback-override.log; } 2>/dev/null || true
fi
set +e; $NAN "set -euo pipefail
F=/etc/nan-relay/api-relay.env; OLD='METAL_ALLOWED_MEASUREMENTS=$PREM,$OLDM'; NEW='METAL_ALLOWED_MEASUREMENTS=$PREM,$OLDM,$NEWM'
if grep -qx \"\$OLD\" \$F; then echo 'the allowlist is already without the 4c measurement'; exit 0; fi
grep -qx \"\$NEW\" \$F || { echo 'REFUSING: the allowlist is neither'; exit 3; }
B=\$F.bak-4c-rollback-\$(date -u +%Y%m%dT%H%M%SZ); cp -p \$F \$B; chmod 600 \$B
sed -i \"s/^\$NEW\\\$/\$OLD/\" \$F
grep -qx \"\$OLD\" \$F && diff <(grep -v '^METAL_ALLOWED_MEASUREMENTS=' \$B) <(grep -v '^METAL_ALLOWED_MEASUREMENTS=' \$F) >/dev/null || { cp -p \$B \$F; echo 'the revert did not verify: file restored'; exit 4; }
systemctl restart enclave-api-relay.service; sleep 8; systemctl is-active --quiet enclave-api-relay.service || { echo 'the relay is not active'; exit 5; }
echo 'the allowlist is 04e953a4,10622d98 again'" > $S4C/4ca-rollback-remote.txt 2>&1; r=$?; cat $S4C/4ca-rollback-remote.txt
set -e; [ $r = 0 ] || { say "4c-a ROLLBACK FAILED on nan"; exit 21; }
wait_for 180 relay_row_ok && say "4c-a ROLLED BACK and checked" || { say "4c-a ROLLBACK: metal-iso0 has not re-attached"; exit 21; }
