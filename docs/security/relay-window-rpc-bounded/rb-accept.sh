#!/usr/bin/env bash
# rpc-bounded acceptance (read-only; pace-accept.sh, bf GO, with the names, the pushed files, and the nucbox-k11 block rs-11/rs-12
# run): the instant predictor probe (a PROBLEM reverts at once); a new invocation, 0 restarts; nan runs the pushed files; the
# pre-warm's round for the live listing; nucbox-k11 attach ACCEPTED (attach line in the NEW invocation <= 180 s, off the relay
# < 10 min, row = before); health (CERT_SEPARATE=1, ADMIT = the admitted release).
set -uo pipefail; source "$(dirname "$0")/lib.sh"
ok=1; bad() { say "RPC-BOUNDED ACCEPT FAIL: $*"; ok=0; }
p=$(probe_predictor); pr=$?; say "predictor probe: $p"
if [ $pr = 2 ]; then say "RPC-BOUNDED: a PREDICTOR PROBLEM after the deploy: REVERTING AT ONCE"; bash "$H/rb-rollback.sh"; exit 1; fi
N=$(listed_ids | wc -l)
inv=$($NAN "systemctl show enclave-api-relay -p InvocationID --value"); nr=$($NAN "systemctl show enclave-api-relay -p NRestarts --value")
[ "$inv" != "$(cat $B/inv0-rb.txt 2>/dev/null)" ] && [ "$nr" = 0 ] || bad "not a clean single restart (${inv:0:12}, NRestarts $nr)"
files_are_pc api-relay.js secrets-release.mjs || bad "nan does not run the pushed files"
end=$(( $(date +%s) + 900 )); pw=""
while [ "$(date +%s)" -lt $end ]; do
  pw=$($NAN "journalctl _SYSTEMD_INVOCATION_ID=$inv --no-pager -o cat | grep -m1 '\[secrets-release\] pre-warm:'" || true); [ -n "$pw" ] && break; sleep 15; done
say "pre-warm: ${pw:-none after 15 min}"; [[ "$pw" == *"prediction(s) ready for $N listed deployment(s)"* ]] || bad "no pre-warm round for the $N listed (the live listing)"
end=$(( $(date +%s) + 180 )); al=""
while [ "$(date +%s)" -lt $end ]; do al=$(hv_attach_line "$inv"); [ -n "$al" ] && break; sleep 10; done
if [ -n "$al" ]; then
  ta=$(date -d "$(cut -d' ' -f1 <<<"$al")" +%s); tr=$(date -d "$($NAN "systemctl show enclave-api-relay -p ActiveEnterTimestamp --value")" +%s); off=$(( ta - tr ))
  say "$HV attach ACCEPTED in ${inv:0:12}: $(cut -d' ' -f1 <<<"$al") (${off} s after the restart)"; [ "$off" -lt 600 ] || bad "$HV was off the relay ${off} s (>= 10 min)"
else bad "$HV did not re-attach in the new invocation within 180 s"; fi
before=$(cat $B/hv-row-before.txt 2>/dev/null); end=$(( $(date +%s) + 120 )); row=""
while [ "$(date +%s)" -lt $end ]; do row=$(hv_row); [ "$row" = "$before" ] && break; sleep 10; done
say "$HV row: '${row:0:90}' (before '${before:0:90}')"; [ -n "$before" ] && [ "$row" = "$before" ] || bad "$HV does not serve what it served before"
CERT_SEPARATE=1 ADMIT="${ADMIT:-$RF}" bash "$HEALTH" > $B/health-after-rb.txt 2>&1; hr=$?; cat $B/health-after-rb.txt; [ $hr = 0 ] || bad "health"
[ $ok = 1 ] && say "RPC-BOUNDED ACCEPTED" || { say "RPC-BOUNDED NOT ACCEPTED: rollback = rb-rollback.sh"; exit 1; }
