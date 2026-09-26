#!/usr/bin/env bash
# rs-11 live acceptance (rs-9-accept.sh with the node allowlist and the NucBox added). apply:
#   1. the api relay restarted by rs-11 (a new invocation, 0 restarts after); the KAT PASS in THAT invocation (health.sh);
#   2. the live METAL_ALLOWED_MEASUREMENTS line = the staged one (lines4.env: the 4 live entries + N1 + N2), and metal-iso0
#      re-attached on its UNCHANGED node image (its attested measurement = 02f6e313, f6cbd75a);
#   3. nucbox-k11 attach ACCEPTED after the restart (enclave-87): its attach line in the NEW invocation, its public row = the
#      row rs-11.sh recorded before, and the time it was off the relay (restart -> attach) under 10 min;
#   4. health.sh CERT_SEPARATE=1 ADMIT="5db18199 aee2059f": settle, the canaries 200/0 on their boot keys, us-west listed, the
#      live listing, and every canary's /v1/expected-guest EXACTLY {5db18199, R} admitted at the pins (63's + bf's); release ON;
#   5. MemoryPeak under 1536M.
# rollback: the same with ADMIT=5db18199 and the allowlist = lines4.before.env's.
set -uo pipefail; source ~/enclave-bench/relay-slice-20260925/lib.sh
say() { local m; m="$(date -u +%H:%M:%SZ) $*"; echo "$m"; { echo "$m" >> "$RS/rollout.log"; } 2>/dev/null || true; }
MODE=${1:?usage: rs-11-accept.sh apply|rollback}; H=$(cd "$(dirname "$0")" && pwd); source "$H/rs11-lib.sh"
case $MODE in apply) ADM="$K $R"; AL=lines4.env ;; rollback) ADM="$K"; AL=lines4.before.env ;; *) echo "apply|rollback"; exit 2 ;; esac
ok=1; bad() { say "RS-11 ACCEPT FAIL: $*"; ok=0; }
prop() { $NAN "systemctl show enclave-api-relay -p $1 --value"; }
inv=$(prop InvocationID); inv0=$(cat "$RS/rs11-$MODE-inv0.txt" 2>/dev/null || true)
[ -n "$inv0" ] && [ "$inv" != "$inv0" ] || bad "the api-relay was not restarted by rs-11 (${inv:0:12}, before ${inv0:0:12})"
la=$(allow_live); ls_=$(allow_staged $AL); say "allowlist line: live ${la:0:12}, staged $AL ${ls_:0:12}"
[ -n "$la" ] && [ "$la" = "$ls_" ] || bad "the live allowlist line is not the staged $AL's"
# the NucBox: its attach in the new invocation (180 s), its row back as before (120 s), off the relay under 10 min
end=$(( $(date +%s) + 180 )); al=""
while [ "$(date +%s)" -lt $end ]; do al=$(hv_attach_line "$inv"); [ -n "$al" ] && break; sleep 10; done
if [ -n "$al" ]; then
  ta=$(date -d "$(cut -d' ' -f1 <<<"$al")" +%s); tr=$(date -d "$(prop ActiveEnterTimestamp)" +%s); off=$(( ta - tr ))
  say "$HV attach ACCEPTED in ${inv:0:12}: $(cut -d' ' -f1 <<<"$al") (${off} s after the restart)"; [ "$off" -lt 600 ] || bad "$HV was off the relay ${off} s (>= 10 min)"
else bad "$HV did not re-attach in the new invocation within 180 s"; fi
before=$(cat "$RS/rs11-$MODE-hvrow0.txt" 2>/dev/null); end=$(( $(date +%s) + 120 )); row=""
while [ "$(date +%s)" -lt $end ]; do row=$(hv_row); [ "$row" = "$before" ] && break; sleep 10; done
say "$HV row: '${row:0:90}' (before '${before:0:90}')"; [ -n "$before" ] && [ "$row" = "$before" ] || bad "$HV does not serve what it served before"
CERT_SEPARATE=1 ADMIT="$ADM" bash "$H/../../hvnode-owner-only-rollout/health.sh" > "$RS/rs11-$MODE-health.txt" 2>&1; hr=$?
cat "$RS/rs11-$MODE-health.txt"; [ $hr = 0 ] || bad "health (the whole output kept in rs11-$MODE-health.txt)"
nm=$(node_meas metal-iso0); say "metal-iso0 attests ${nm:0:12}"; [ "$nm" = "$LIVE_NODE" ] || bad "metal-iso0 is not back on its unchanged image 02f6e313 (${nm:0:20})"
peak=$(prop MemoryPeak); say "MemoryPeak $peak"; [[ "$peak" =~ ^[0-9]+$ ]] && [ "$peak" -lt $((1536*1024*1024)) ] || bad "MemoryPeak $peak"
[ $ok = 1 ] && say "RS-11 $MODE ACCEPTED" || { say "RS-11 $MODE NOT ACCEPTED$([ "$MODE" = apply ] && echo ': rollback = rs-11.sh rollback, then rs-11-accept.sh rollback')"; exit 1; }
