#!/usr/bin/env bash
# Pacing acceptance (read-only): the instant predictor probe (a PROBLEM reverts at once); a new invocation, 0 restarts; nan runs
# the pushed file; the pre-warm's first round logged for the N live-listed (the paced shape: '… ready for N listed'); health
# (CERT_SEPARATE=1 ADMIT=the admitted release: every canary's expected guest exactly that release at its pin).
set -uo pipefail; source "$(dirname "$0")/lib.sh"
ok=1; bad() { say "PACING ACCEPT FAIL: $*"; ok=0; }
p=$(probe_predictor); pr=$?; say "predictor probe: $p"
if [ $pr = 2 ]; then say "PACING: a PREDICTOR PROBLEM after the deploy: REVERTING AT ONCE"; bash "$H/pace-rollback.sh"; exit 1; fi
N=$(listed_ids | wc -l)
inv=$($NAN "systemctl show enclave-api-relay -p InvocationID --value"); nr=$($NAN "systemctl show enclave-api-relay -p NRestarts --value")
[ "$inv" != "$(cat $B/inv0-pace.txt 2>/dev/null)" ] && [ "$nr" = 0 ] || bad "not a clean single restart (${inv:0:12}, NRestarts $nr)"
files_are_pc secrets-release.mjs || bad "nan does not run the pushed files"
end=$(( $(date +%s) + 900 )); pw=""
while [ "$(date +%s)" -lt $end ]; do
  pw=$($NAN "journalctl _SYSTEMD_INVOCATION_ID=$inv --no-pager -o cat | grep -m1 '\[secrets-release\] pre-warm:'" || true); [ -n "$pw" ] && break; sleep 15; done
say "pre-warm: ${pw:-none after 15 min}"; [[ "$pw" == *"prediction(s) ready for $N listed deployment(s)"* ]] || bad "no pre-warm round for the $N listed (the live listing)"
CERT_SEPARATE=1 ADMIT="${ADMIT:-$RF}" bash "$HEALTH" > $B/health-after-pace.txt 2>&1; hr=$?; cat $B/health-after-pace.txt; [ $hr = 0 ] || bad "health"
[ $ok = 1 ] && say "PACING ACCEPTED" || { say "PACING NOT ACCEPTED: rollback = pace-rollback.sh"; exit 1; }
