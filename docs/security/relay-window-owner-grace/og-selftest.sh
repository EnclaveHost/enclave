#!/usr/bin/env bash
# Executes every check og-push/og-accept ADD to the reviewed pacing scripts, read-only, against the LIVE relay (the current
# invocation) and against the pinned source (enclave-87's standing order: every new code path runs before live use). Exit 0 = all
# behave: each check passes where it must AND refuses where it must.
set -uo pipefail; source "$(dirname "$0")/lib.sh"
n=0; f=0; t() { n=$((n+1)); if [ "$1" = ok ]; then echo "ok   $2"; else echo "FAIL $2"; f=$((f+1)); fi; }
row=$(hv_row); [[ "$row" == "hv-node true 0x"* ]] && t ok "hv_row($HV) = '$row'" || t no "hv_row($HV) = '$row'"
[ "$(hv_row no-such-box)" = absent ] && t ok "hv_row(no-such-box) = absent" || t no "hv_row(no-such-box)"
inv=$($NAN "systemctl show enclave-api-relay -p InvocationID --value")
al=$(hv_attach_line "$inv"); [ -n "$al" ] && t ok "hv_attach_line(${inv:0:12}) = ${al:0:90}" || t no "hv_attach_line(${inv:0:12}) empty"
[ -z "$(hv_attach_line "$inv" no-such-box)" ] && t ok "hv_attach_line(no-such-box) empty" || t no "hv_attach_line(no-such-box) not empty"
g=$(grace_lines "$inv"); [[ "$g" =~ ^[0-9]+$ ]] && t ok "grace_lines(${inv:0:12}) = $g (a count)" || t no "grace_lines not a count: '$g'"
# GRACE_RE against the wording the PINNED code logs (a drift in wording would blind the accept) and against lines it must not count
src=$(git -C $MAIN show $PC:relay/tunnel.js; git -C $MAIN show $PC:relay/api-relay.js)
for ph in "owner-only serving SUSPENDED" "owner-only starts SUSPENDED" "owner read FAILED: serving on" "is not a whole number of milliseconds"; do
  grep -qF "$ph" <<<"$src" && t ok "PC logs '$ph'" || t no "PC does not log '$ph'"; done
pos=$'[tunnel] nucbox-k11 owner-only serving SUSPENDED: no successful owner read for 901 s (grace 900 s); it serves nothing until one succeeds\n[tunnel] nucbox-k11 owner-only starts SUSPENDED: no successful owner read within the grace (900 s); it serves nothing until one succeeds\n[tunnel] nucbox-k11 owner read FAILED: serving on the owner read 61 s ago, for at most 900 s since that read\n[api-relay] TUNNEL_OWNER_GRACE_MS="-5" is not a whole number of milliseconds >= 0: using the default 900000\n[api-relay] TUNNEL_OWNER_RECHECK_MS="abc" is not a whole number of milliseconds >= 250: using the default 60000'
neg=$'[tunnel] nucbox-k11 owner read recovered\n[tunnel] nucbox-k11 owner-only serving RESUMED: the owner read succeeded and is still 0x389c\n[tunnel] nucbox-k11 attached via attestation(hv-node) (3 enclaves)\n[secrets-release] pre-warm: 14 prediction(s) ready for 7 listed deployment(s) in 61271 ms'
[ "$(grep -cE "$GRACE_RE" <<<"$pos")" = 5 ] && t ok "GRACE_RE counts all 5 state-change/env lines" || t no "GRACE_RE counts $(grep -cE "$GRACE_RE" <<<"$pos") of 5"
[ "$(grep -cE "$GRACE_RE" <<<"$neg" || true)" = 0 ] && t ok "GRACE_RE counts none of recovered/RESUMED/attach/pre-warm" || t no "GRACE_RE counts a line it must not"
if files_are_pc tunnel.js api-relay.js >/dev/null; then t no "files_are_pc passes BEFORE the push (nan should run main's files)"; else t ok "files_are_pc refuses before the push: $(files_are_pc tunnel.js api-relay.js)"; fi
echo "og-selftest: $((n-f))/$n"; [ $f = 0 ]
