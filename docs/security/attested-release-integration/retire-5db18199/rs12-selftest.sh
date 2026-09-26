#!/usr/bin/env bash
# rs-12's added paths, read-only on the LIVE relay BEFORE the window (enclave-87: every new code path runs before live use). The
# guard's live run is evidence/guard-negative-control.txt (it REFUSES while the canaries are on 5db18199, as it must).
set -uo pipefail; source ~/enclave-bench/relay-slice-20260925/lib.sh; H=$(cd "$(dirname "$0")" && pwd); source "$H/rs12-lib.sh"
n=0; f=0; t() { n=$((n+1)); if [ "$1" = ok ]; then echo "ok   $2"; else echo "FAIL $2"; f=$((f+1)); fi; }
row=$(hv_row); [[ "$row" == "hv-node true 0x"* ]] && t ok "hv_row($HV) = ${row:0:40}…" || t no "hv_row($HV) = $row"
[ "$(hv_row no-such-box)" = absent ] && t ok "hv_row(no-such-box) = absent" || t no "hv_row(no-such-box)"
inv=$($NAN "systemctl show enclave-api-relay -p InvocationID --value"); al=$(hv_attach_line "$inv")
[ -n "$al" ] && t ok "hv_attach_line(${inv:0:12}) = ${al:0:32}…" || t no "hv_attach_line(${inv:0:12}) empty"
[ -z "$(hv_attach_line "$inv" no-such-box)" ] && t ok "hv_attach_line(no-such-box) empty" || t no "hv_attach_line(no-such-box) not empty"
H1=$(mktemp); H2=$(mktemp)
CERT_SEPARATE=1 ADMIT="5db18199ef0d321ea9dc8c81e385cb057efd05c2ef5d29e471b81fb2b78c2a77 aee2059ffcc7bd8a459001cba02a7e9139d6a4aa964fd6de68047407f8597532" bash "$H/../../hvnode-owner-only-rollout/health.sh" > $H1 2>&1 \
  && t ok "health ADMIT='5db18199 aee2059f' passes NOW (the rollback accept's target = rs-11's state)" || t no "health rollback target fails now: $(tail -1 $H1)"
CERT_SEPARATE=1 ADMIT="aee2059ffcc7bd8a459001cba02a7e9139d6a4aa964fd6de68047407f8597532" bash "$H/../../hvnode-owner-only-rollout/health.sh" > $H2 2>&1 \
  && t no "health ADMIT=aee2059f passes BEFORE 5db18199 is retired" \
  || { grep -q "expected-guest .* is not exactly \[aee2059f \]" $H2 && t ok "health ADMIT=aee2059f FAILS now on the expected guest (5db18199 still admitted): the apply accept discriminates" || t no "health ADMIT=aee2059f fails for another reason: $(grep -m1 UNHEALTHY $H2 | cut -c1-120)"; }
rm -f $H1 $H2
echo "rs12-selftest: $((n-f))/$n"; [ $f = 0 ]
