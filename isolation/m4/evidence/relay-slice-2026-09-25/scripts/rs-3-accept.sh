#!/usr/bin/env bash
# Step 3, live acceptance (enclave-d1 + e3): the api-relay restarted once by CI and stays up (0 restarts after), /v1/enclaves
# 200, the serving-node count back to its step-1 value, the predictor's known-answer test PASS in the journal (the first
# run is COLD: allow up to 15 min), accept.sh (each canary's measurement predicted; release-ticket 503; 404/422), the
# relay's MemoryPeak under 1536M, and the canaries' public TLS unchanged (the pool rollout's public_ok: 200 with their
# S0 keys) and metal-iso0 serving and eligible.
set -uo pipefail; source ~/enclave-bench/relay-slice-20260925/lib.sh; source ~/enclave-bench/pool-rollout-20260925/lib.sh
say() { local m; m="$(date -u +%H:%M:%SZ) $*"; echo "$m"; { echo "$m" >> "$RS/rollout.log"; } 2>/dev/null || true; }   # not lib.sh's
ok=1; bad() { say "ACCEPT FAIL: $*"; ok=0; }
prop() { $NAN "systemctl show enclave-api-relay -p $1 --value"; }   # one property per call: the order of several is not fixed
as=$(prop ActiveState); nr=$(prop NRestarts); since=$(prop ActiveEnterTimestamp); inv=$(prop InvocationID)
say "api-relay: $as, NRestarts $nr, since $since, invocation ${inv:0:12}"
[ "$as" = active ] && [ "$nr" = 0 ] || bad "api-relay not active or restarted"
[[ "$since" == *" 2026-09-25 "* ]] && [ "$since" != "Fri 2026-09-25 18:00:46 UTC" ] || bad "the api-relay was not restarted by the deploy (still since $since)"
[ "$(curl -sS -o /dev/null -w '%{http_code}' --max-time 20 https://api.enclave.host/v1/enclaves)" = 200 ] || bad "/v1/enclaves is not 200"
# the known-answer test of THIS relay process (its invocation's journal); the first run is cold: up to 15 min
end=$(( $(date +%s) + 900 )); kat=""
while [ $(date +%s) -lt $end ]; do
  kat=$($NAN "journalctl _SYSTEMD_INVOCATION_ID=$inv --no-pager -o cat | grep -m1 'known-answer test at start'" || true)
  [ -n "$kat" ] && break; sleep 15
done
say "KAT: ${kat:-none after 15 min}"; [[ "$kat" == *"PASS: 2 known answer(s)"* ]] || bad "no KAT PASS"
b=$(cat $RS/serving-before.txt); for i in $(seq 1 24); do n=$(serving_nodes || echo 0); [ "$n" -ge "$b" ] && break; sleep 10; done
say "serving nodes: $n (before $b)"; [ "$n" -ge "$b" ] || bad "serving nodes $n < $b"
$RS/accept.sh > $RS/accept-out.txt 2>&1; ar=$?; cat $RS/accept-out.txt; [ $ar = 0 ] || bad "accept.sh rc=$ar"
peak=$(prop MemoryPeak); say "MemoryPeak $peak"
[[ "$peak" =~ ^[0-9]+$ ]] && [ "$peak" -lt $((1536*1024*1024)) ] || bad "MemoryPeak $peak"
wait_for 120 public_ok || bad "the canaries do not serve with their keys"
relay_row_ok || bad "metal-iso0 is not serving and eligible"
[ $ok = 1 ] && say "RELAY SLICE ACCEPTED" || { say "RELAY SLICE NOT ACCEPTED: decide the rollback (rs-rollback-config.sh, then rs-rollback-code.sh)"; exit 1; }
