#!/usr/bin/env bash
# Executes every check rs-11.sh / rs-11-accept.sh ADD to rs-9's, read-only, against the LIVE relay BEFORE the window (enclave-87:
# every new code path runs before live use): each passes where it must and refuses where it must. Nothing on nan is changed.
set -uo pipefail; source ~/enclave-bench/relay-slice-20260925/lib.sh; H=$(cd "$(dirname "$0")" && pwd); source "$H/rs11-lib.sh"
n=0; f=0; t() { n=$((n+1)); if [ "$1" = ok ]; then echo "ok   $2"; else echo "FAIL $2"; f=$((f+1)); fi; }
m=$(node_meas metal-iso0); [ "$m" = "$LIVE_NODE" ] && t ok "node_meas(metal-iso0) = ${m:0:12} (f6cbd75a's)" || t no "node_meas(metal-iso0) = ${m:0:20}"
[ "$(node_meas no-such-box)" = absent ] && t ok "node_meas(no-such-box) = absent" || t no "node_meas(no-such-box)"
E=$(mktemp); rm -f "$E"
S9_EPOCH=$E rollback_guard "$m" >/dev/null && t ok "rollback_guard: node on 02f6e313, no S9 -> passes" || t no "rollback_guard refuses the live state"
why=$(S9_EPOCH=$E rollback_guard "$N1") && t no "rollback_guard passes a node on N1" || t ok "rollback_guard: node on N1 -> refuses ($why)"
why=$(S9_EPOCH=$E rollback_guard "$N2") && t no "rollback_guard passes a node on N2" || t ok "rollback_guard: node on N2 -> refuses (${why:0:40}…)"
why=$(S9_EPOCH=$E rollback_guard "absent") && t no "rollback_guard passes an unreadable node" || t ok "rollback_guard: unreadable node -> refuses ($why)"
echo 1790410000 > "$E"; why=$(S9_EPOCH=$E rollback_guard "$m") && t no "rollback_guard passes after S9" || t ok "rollback_guard: S9 epoch present -> refuses (${why:0:50}…)"
out=$(S9_EPOCH=$E bash "$H/rs-11.sh" rollback 2>&1); rc=$?; rm -f "$E"
[ $rc = 4 ] && grep -q "REFUSING rs-11 rollback: S9 switched" <<<"$out" && t ok "rs-11.sh rollback refuses at its guard (rc 4) before touching nan" || t no "rs-11.sh rollback with S9: rc $rc ${out:0:120}"
row=$(hv_row); [[ "$row" == "hv-node true 0x"* ]] && t ok "hv_row($HV) = ${row:0:40}…" || t no "hv_row($HV) = $row"
inv=$($NAN "systemctl show enclave-api-relay -p InvocationID --value"); al=$(hv_attach_line "$inv")
[ -n "$al" ] && t ok "hv_attach_line(${inv:0:12}) = ${al:0:32}…" || t no "hv_attach_line(${inv:0:12}) empty"
ta=$(date -d "$(cut -d' ' -f1 <<<"$al")" +%s 2>/dev/null); [[ "$ta" =~ ^[0-9]+$ ]] && t ok "the attach time parses ($(cut -d' ' -f1 <<<"$al"))" || t no "the attach time does not parse"
la=$(allow_live); lb=$(allow_staged lines4.before.env); lz=$(allow_staged lines4.env)
[ -n "$la" ] && [ "$la" = "$lb" ] && t ok "allowlist: live = staged BEFORE (${la:0:12})" || t no "allowlist: live ${la:0:12} != before ${lb:0:12}"
[ "$la" != "$lz" ] && t ok "allowlist: live != staged AFTER (${lz:0:12}): the apply accept discriminates" || t no "allowlist: live already = after"
CERT_SEPARATE=1 ADMIT="$K" bash "$H/../../hvnode-owner-only-rollout/health.sh" > /tmp/rs11-h1.$$ 2>&1 && t ok "health ADMIT=5db18199 passes NOW (the rollback accept's target)" || t no "health ADMIT=5db18199 fails now: $(tail -2 /tmp/rs11-h1.$$)"
CERT_SEPARATE=1 ADMIT="$K $R" bash "$H/../../hvnode-owner-only-rollout/health.sh" > /tmp/rs11-h2.$$ 2>&1 && t no "health ADMIT='5db18199 R' passes BEFORE R is admitted" \
  || { grep -q "aee2059f\|expected guest" /tmp/rs11-h2.$$ && t ok "health ADMIT='5db18199 R' FAILS now on the expected guest (R's pins are wired; R not admitted yet)" || t no "health ADMIT='5db18199 R' fails for another reason: $(grep -m2 FAIL /tmp/rs11-h2.$$)"; }
grep -m1 "FAIL\|expected" /tmp/rs11-h2.$$ | cut -c1-160; rm -f /tmp/rs11-h1.$$ /tmp/rs11-h2.$$
echo "rs11-selftest: $((n-f))/$n"; [ $f = 0 ]
