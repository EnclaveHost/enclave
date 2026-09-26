#!/usr/bin/env bash
# Owner-grace acceptance (read-only; derived from pace-accept.sh): the instant predictor probe (a PROBLEM reverts at once); a new
# invocation, 0 restarts; nan runs the pushed files; the hv-node box RE-ATTACHED in the new invocation (its journal line) and its
# public row serves owner-only EXACTLY what it served before the window (hv-row-before.txt); no owner-grace state-change or env
# line in the new invocation (a clean restart reads the owner fine); health (CERT_SEPARATE=1, ADMIT = the admitted release).
# Then d1 confirms test 1 is 200 via /x (the soak monitor's check), which this script cannot see.
set -uo pipefail; source "$(dirname "$0")/lib.sh"
ok=1; bad() { say "OWNER-GRACE ACCEPT FAIL: $*"; ok=0; }
p=$(probe_predictor); pr=$?; say "predictor probe: $p"
if [ $pr = 2 ]; then say "OWNER-GRACE: a PREDICTOR PROBLEM after the deploy: REVERTING AT ONCE"; bash "$H/og-rollback.sh"; exit 1; fi
inv=$($NAN "systemctl show enclave-api-relay -p InvocationID --value"); nr=$($NAN "systemctl show enclave-api-relay -p NRestarts --value")
[ "$inv" != "$(cat $B/inv0-og.txt 2>/dev/null)" ] && [ "$nr" = 0 ] || bad "not a clean single restart (${inv:0:12}, NRestarts $nr)"
files_are_pc tunnel.js api-relay.js || bad "nan does not run the pushed files"
end=$(( $(date +%s) + 180 )); al=""
while [ "$(date +%s)" -lt $end ]; do al=$(hv_attach_line "$inv"); [ -n "$al" ] && break; sleep 10; done
say "$HV attach: ${al:-none in 180 s}"; [ -n "$al" ] || bad "$HV did not re-attach in the new invocation"
before=$(cat $B/hv-row-before.txt 2>/dev/null); end=$(( $(date +%s) + 120 )); row=""
while [ "$(date +%s)" -lt $end ]; do row=$(hv_row); [ "$row" = "$before" ] && break; sleep 10; done
say "$HV row: after '$row', before '$before'"; [ -n "$before" ] && [ "$row" = "$before" ] || bad "$HV does not serve owner-only what it served before"
g=$(grace_lines "$inv"); say "owner-grace lines in the new invocation: ${g:-?}"; [ "$g" = 0 ] || bad "owner-grace logged a state change or an env complaint (${g:-?})"
CERT_SEPARATE=1 ADMIT="${ADMIT:-$RF}" bash "$HEALTH" > $B/health-after-og.txt 2>&1; hr=$?; cat $B/health-after-og.txt; [ $hr = 0 ] || bad "health"
[ $ok = 1 ] && say "OWNER-GRACE ACCEPTED (relay side): tell d1 to confirm test 1 is 200 via /x" || { say "OWNER-GRACE NOT ACCEPTED: rollback = og-rollback.sh"; exit 1; }
