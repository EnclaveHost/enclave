#!/usr/bin/env bash
# rs-12 (the RETIRE of 5db18199) live acceptance: rs-10-accept.sh (bf GO, run 06:29Z) with the releases retargeted and the NucBox
# check rs-11 ran (enclave-87's mid-soak rule). apply:
#   1. the api relay restarted by rs-12 (a new invocation, 0 restarts after); the KAT PASS in THAT invocation (health.sh);
#   2. nucbox-k11 attach ACCEPTED: its attach line in the NEW invocation, off the relay < 10 min, its row = the recorded one;
#   3. health.sh CERT_SEPARATE=1 ADMIT="aee2059f": settle (us-west + metal-iso0 re-attached), the canaries 200/0 on their boot
#      keys, us-west listed, the live listing, and every canary's /v1/expected-guest EXACTLY {aee2059f} admitted at the pins
#      (63's + bf's) - nothing else (no KAT-only or retired release); release ON (a ticket 403); 404; 422;
#   4. MemoryPeak under 1536M.
# rollback: the same with ADMIT="5db18199 aee2059f" (rs-11's state).
set -uo pipefail; source ~/enclave-bench/relay-slice-20260925/lib.sh
say() { local m; m="$(date -u +%H:%M:%SZ) $*"; echo "$m"; { echo "$m" >> "$RS/rollout.log"; } 2>/dev/null || true; }
MODE=${1:?usage: rs-12-accept.sh apply|rollback}; H=$(cd "$(dirname "$0")" && pwd); source "$H/rs12-lib.sh"
F=5db18199ef0d321ea9dc8c81e385cb057efd05c2ef5d29e471b81fb2b78c2a77; N=aee2059ffcc7bd8a459001cba02a7e9139d6a4aa964fd6de68047407f8597532
case $MODE in apply) ADM="$N" ;; rollback) ADM="$F $N" ;; *) echo "apply|rollback"; exit 2 ;; esac
ok=1; bad() { say "RS-12 ACCEPT FAIL: $*"; ok=0; }
prop() { $NAN "systemctl show enclave-api-relay -p $1 --value"; }
inv=$(prop InvocationID); inv0=$(cat "$RS/rs12-$MODE-inv0.txt" 2>/dev/null || true)
[ -n "$inv0" ] && [ "$inv" != "$inv0" ] || bad "the api-relay was not restarted by rs-12 (${inv:0:12}, before ${inv0:0:12})"
# nucbox-k11 attach ACCEPTED after the restart (enclave-87, mid-soak): its attach line in the NEW invocation within 180 s, off the
# relay under 10 min, and its row = the row rs-12.sh recorded before
end=$(( $(date +%s) + 180 )); al=""
while [ "$(date +%s)" -lt $end ]; do al=$(hv_attach_line "$inv"); [ -n "$al" ] && break; sleep 10; done
if [ -n "$al" ]; then
  ta=$(date -d "$(cut -d' ' -f1 <<<"$al")" +%s); tr=$(date -d "$(prop ActiveEnterTimestamp)" +%s); off=$(( ta - tr ))
  say "$HV attach ACCEPTED in ${inv:0:12}: $(cut -d' ' -f1 <<<"$al") (${off} s after the restart)"; [ "$off" -lt 600 ] || bad "$HV was off the relay ${off} s (>= 10 min)"
else bad "$HV did not re-attach in the new invocation within 180 s"; fi
before=$(cat "$RS/rs12-$MODE-hvrow0.txt" 2>/dev/null); end=$(( $(date +%s) + 120 )); row=""
while [ "$(date +%s)" -lt $end ]; do row=$(hv_row); [ "$row" = "$before" ] && break; sleep 10; done
say "$HV row: '${row:0:90}' (before '${before:0:90}')"; [ -n "$before" ] && [ "$row" = "$before" ] || bad "$HV does not serve what it served before"
CERT_SEPARATE=1 ADMIT="$ADM" bash "$H/../../hvnode-owner-only-rollout/health.sh" > "$RS/rs12-$MODE-health.txt" 2>&1; hr=$?
cat "$RS/rs12-$MODE-health.txt"; [ $hr = 0 ] || bad "health (the whole output kept in rs12-$MODE-health.txt)"
peak=$(prop MemoryPeak); say "MemoryPeak $peak"; [[ "$peak" =~ ^[0-9]+$ ]] && [ "$peak" -lt $((1536*1024*1024)) ] || bad "MemoryPeak $peak"
[ $ok = 1 ] && say "RS-12 $MODE ACCEPTED" || { say "RS-12 $MODE NOT ACCEPTED$([ "$MODE" = apply ] && echo ': rollback = rs-12.sh rollback, then rs-12-accept.sh rollback')"; exit 1; }
