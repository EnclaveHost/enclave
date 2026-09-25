#!/usr/bin/env bash
# U7 step 3 (7.3): smoke nan / nan-relay after the CI deploy: metal-iso0 reattached + 30 s; every nan-relay data-plane
# journal shows the eligibility line and NOT "unset: NO host is eligible"; the canaries 200 via nan-relay (not vacuous: U7's
# splice refuses an origin fleet.eligibleOrigin does not hold eligible) with NO "REFUSED: not an eligible host (U7)" for a
# canary; /x/<id>/ GET 421; a no-lease /x/ 404; metal-iso0 eligible; /t/metal-iso0/availability 200; the api relay's
# journal without a repeating "U7: closed"; via us-west (old code) the canaries still 200; the relay slice's accept.sh
# (expected-guest + release 503) still passes. The refusal of an INELIGIBLE holder cannot be shown live (no such lease):
# it rests on the U7 suites on the converged commit.
set -uo pipefail; source ~/enclave-bench/u7-20260925/lib.sh; source ~/enclave-bench/pool-rollout-20260925/lib.sh
say() { local m; m="$(date -u +%H:%M:%SZ) $*"; echo "$m"; { echo "$m" >> "$U7/rollout.log"; } 2>/dev/null || true; }
ok=1; bad() { say "U7 SMOKE FAIL: $*"; ok=0; }
wait_for 180 relay_row_ok || bad "metal-iso0 did not re-attach"
t=$(( $(date +%s) + 30 )); while [ $(date +%s) -lt $t ]; do sleep 2; done   # the 30 s grace after reattach
since=$($NR "systemctl show enclave-tcp-relay -p ActiveEnterTimestamp --value")
for u in tcp-relay tcp6-relay udp-relay dns; do j=$($NR "journalctl -u enclave-$u --since '$since' --no-pager -o cat" 2>/dev/null)
  grep -q 'eligibility: https://api.enclave.host/enclaves every 15s' <<<"$j" || bad "$u: no eligibility line"; ! grep -q 'unset: NO host is eligible' <<<"$j" || bad "$u: UNSET feed"; done
jt=$($NR "journalctl -u enclave-tcp-relay --since '$since' --no-pager -o cat" 2>/dev/null)
for l in $LABELS; do ! grep -q "REFUSED: not an eligible host (U7).*$l" <<<"$jt" || bad "tcp-relay refused canary $l"; done
canary200 46.62.128.36 || bad "a canary is not 200 via nan-relay"
for id in $IDS; do r=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 20 https://api.enclave.host/x/$id/); [ "$r" = 421 ] || bad "/x/${id:0:10}/ answered $r, not 421"; done
r=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 20 https://api.enclave.host/x/0x$(printf 'cd%.0s' $(seq 32))/); [ "$r" = 404 ] || bad "a no-lease /x/ answered $r, not 404"
[ "$(curl -sS -o /dev/null -w '%{http_code}' --max-time 20 https://api.enclave.host/t/metal-iso0/availability)" = 200 ] || bad "/t/metal-iso0/availability not 200"
n=$($NAN "journalctl -u enclave-api-relay --since '-5min' --no-pager -o cat | grep -c 'U7: closed'" || echo 0); [ "${n:-0}" -le 3 ] || bad "the api relay logs U7: closed repeatedly ($n in 5 min)"
canary200 5.78.85.108 || bad "a canary is not 200 via us-west (old code)"
~/enclave-bench/relay-slice-20260925/accept.sh > $U7/smoke-accept.txt 2>&1 || bad "the relay slice's accept.sh fails (smoke-accept.txt)"
wait_for 60 public_ok || bad "public_ok"
probe "$NR" > $U7/probe-nanrelay-after2.txt 2>&1
[ $ok = 1 ] && say "U7 STEP 3 SMOKE PASSED (nan / nan-relay on U7; us-west still old)" || { say "U7 STEP 3 SMOKE FAILED: rollback = u7-rollback-code.sh"; exit 1; }
