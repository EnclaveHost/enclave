#!/usr/bin/env bash
# Step 2 acceptance (read-only): a new api-relay invocation, 0 restarts; nan runs the pushed files; the KAT PASS in the new
# invocation and, after it, the pre-warm's first round logged (N predictions ready for the 7 listed); health (the release
# settings unchanged: the cert set is NOT separate yet - the code is inert until step 3's env line).
set -uo pipefail; source "$(dirname "$0")/lib.sh"
ok=1; bad() { say "STEP 2 ACCEPT FAIL: $*"; ok=0; }
p=$(probe_predictor); pr=$?; say "predictor probe: $p"
if [ $pr = 2 ]; then say "STEP 2: a PREDICTOR PROBLEM after the deploy: REVERTING AT ONCE"; bash "$H/pc-2-rollback.sh"; exit 1; fi
N=$(listed_ids | wc -l)
inv=$($NAN "systemctl show enclave-api-relay -p InvocationID --value"); nr=$($NAN "systemctl show enclave-api-relay -p NRestarts --value")
[ "$inv" != "$(cat $B/inv0-2.txt 2>/dev/null)" ] && [ "$nr" = 0 ] || bad "not a clean single restart (${inv:0:12}, NRestarts $nr)"
files_are_pc api-relay.js secrets-release.mjs measurement-predict.mjs || bad "nan does not run the pushed files"
end=$(( $(date +%s) + 900 )); pw=""
while [ "$(date +%s)" -lt $end ]; do
  pw=$($NAN "journalctl _SYSTEMD_INVOCATION_ID=$inv --no-pager -o cat | grep -m1 '\[secrets-release\] pre-warm:'" || true); [ -n "$pw" ] && break; sleep 15; done
say "pre-warm: ${pw:-none after 15 min}"; [[ "$pw" == *"prediction(s) ready for $N listed deployment(s)"* ]] || bad "no pre-warm round for the $N listed (the live listing)"
bash "$HEALTH" > $B/health-after-2.txt 2>&1; hr=$?; cat $B/health-after-2.txt; [ $hr = 0 ] || bad "health"
[ $ok = 1 ] && say "STEP 2 ACCEPTED" || { say "STEP 2 NOT ACCEPTED: rollback = a revert of the 4 commits pushed to main"; exit 1; }
