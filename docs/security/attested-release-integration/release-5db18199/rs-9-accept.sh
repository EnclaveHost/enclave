#!/usr/bin/env bash
# rs-9 live acceptance (three lines; the cert set explicit). apply:
#   1. the api relay restarted by rs-9 (a new invocation, 0 restarts after); the KAT PASS in THAT invocation (health.sh);
#   2. health.sh CERT_SEPARATE=1 ADMIT="f7888d86 5db18199": settle (us-west + metal-iso0 re-attached), the canaries 200/0 on
#      their guests' boot keys, us-west listed, every LIVE-listed id listed:true (an unlisted one not), and every canary's
#      /v1/expected-guest EXACTLY {f7888d86, 5db18199}, both admitted, at the pins (63's + bf's independent values) - nothing
#      else (no KAT-only or retired release); release ON (a ticket 403); 404; 422;
#   3. MemoryPeak under 1536M.
# rollback: the same with ADMIT=f7888d86 alone.
set -uo pipefail; source ~/enclave-bench/relay-slice-20260925/lib.sh
say() { local m; m="$(date -u +%H:%M:%SZ) $*"; echo "$m"; { echo "$m" >> "$RS/rollout.log"; } 2>/dev/null || true; }
MODE=${1:?usage: rs-9-accept.sh apply|rollback}; H=$(cd "$(dirname "$0")" && pwd)
F=f7888d8690845cbb862c1fbcae0a22f5458fcb891de7d0d3ae31ea927536b7ca; N=5db18199ef0d321ea9dc8c81e385cb057efd05c2ef5d29e471b81fb2b78c2a77
case $MODE in apply) ADM="$F $N" ;; rollback) ADM="$F" ;; *) echo "apply|rollback"; exit 2 ;; esac
ok=1; bad() { say "RS-9 ACCEPT FAIL: $*"; ok=0; }
prop() { $NAN "systemctl show enclave-api-relay -p $1 --value"; }
inv=$(prop InvocationID); inv0=$(cat "$RS/rs9-$MODE-inv0.txt" 2>/dev/null || true)
[ -n "$inv0" ] && [ "$inv" != "$inv0" ] || bad "the api-relay was not restarted by rs-9 (${inv:0:12}, before ${inv0:0:12})"
CERT_SEPARATE=1 ADMIT="$ADM" bash "$H/../../hvnode-owner-only-rollout/health.sh" > "$RS/rs9-$MODE-health.txt" 2>&1; hr=$?
cat "$RS/rs9-$MODE-health.txt"; [ $hr = 0 ] || bad "health (the whole output kept in rs9-$MODE-health.txt)"
peak=$(prop MemoryPeak); say "MemoryPeak $peak"; [[ "$peak" =~ ^[0-9]+$ ]] && [ "$peak" -lt $((1536*1024*1024)) ] || bad "MemoryPeak $peak"
[ $ok = 1 ] && say "RS-9 $MODE ACCEPTED" || { say "RS-9 $MODE NOT ACCEPTED$([ "$MODE" = apply ] && echo ': rollback = rs-9.sh rollback, then rs-9-accept.sh rollback')"; exit 1; }
