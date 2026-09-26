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
# the SOAK gate (enclave-5d's REQUIRED fixes): every outcome of soak_gate, and og-push.sh itself refusing a non-0/1 DRY
fl=$(date -d "$SOAK_END" +%s)
g() { local out rc; out=$(soak_gate "$@"); rc=$?; echo "$rc:$out"; }
chk() { local want=$1 name=$2; shift 2; local got; got=$(g "$@"); [[ "$got" == $want* ]] && t ok "soak_gate $name -> ${got:0:60}" || t no "soak_gate $name -> $got (want $want)"; }
chk "0:closed" "before the floor, SOAK_DONE=1"            $((fl-1)) 0 1 "$SOAK_END"
chk "0:open"   "at the floor, SOAK_DONE=1"                $fl 0 1 "$SOAK_END"
chk "0:closed" "after the floor, SOAK_DONE unset"         $((fl+60)) 0 "" "$SOAK_END"
chk "0:closed" "after the floor, SOAK_DONE=true"          $((fl+60)) 0 true "$SOAK_END"
chk "0:open"   "DRY=1 after the floor, SOAK_DONE=1"       $((fl+60)) 1 1 "$SOAK_END"
chk "2:REFUSING: DRY must be exactly 0 or 1" "DRY=true"   $((fl+60)) true 1 "$SOAK_END"
chk "2:REFUSING: DRY must be exactly 0 or 1" "DRY=' 1'"   $((fl+60)) " 1" 1 "$SOAK_END"
chk "2:REFUSING: DRY must be exactly 0 or 1" "DRY=yes"    $((fl+60)) yes 1 "$SOAK_END"
chk "2:REFUSING: SOAK_END" "an unparsable floor"          $((fl+60)) 0 1 "not-a-time"
chk "2:REFUSING: SOAK_END" "an empty floor"               $((fl+60)) 0 1 ""
chk "2:REFUSING: SOAK_END" "a floor that date -d accepts but is not the literal ('tomorrow')" $((fl+60)) 0 1 "tomorrow"
chk "2:REFUSING: now" "a non-numeric now"                 "abc" 0 1 "$SOAK_END"
# og-push.sh itself, only as a SANDBOXED COPY (enclave-87's hard rule: a test never calls a production push/rollback path on live
# state): og-push.sh + lib.sh in a temp dir; git, gh, ssh and curl on PATH are shims that log and FAIL, so even a regressed gate
# could not fetch, push or reach nan; MAIN points into the sandbox
SB=$(mktemp -d); mkdir -p $SB/bin; cp "$H/og-push.sh" "$H/lib.sh" $SB/
sed -i "s#MAIN=/home/steven/Projects/enclave#MAIN=$SB/no-main#" $SB/lib.sh; grep -q "MAIN=$SB/no-main" $SB/lib.sh || t no "HARNESS: MAIN not redirected"
for c in git gh ssh curl; do printf '#!/bin/sh\necho "SHIM-CALLED %s $*" >> %s/shim.log; exit 1\n' "$c" "$SB" > $SB/bin/$c; chmod 755 $SB/bin/$c; done
for d in true " 1" yes; do out=$(PATH="$SB/bin:$PATH" DRY="$d" SOAK_DONE=1 B_DIR=$SB/b bash "$SB/og-push.sh" 2>&1); rc=$?
  [ $rc = 2 ] && grep -q "DRY must be exactly 0 or 1" <<<"$out" && t ok "SANDBOXED og-push.sh DRY='$d' SOAK_DONE=1 refuses at the gate (rc 2)" || t no "sandboxed og-push.sh DRY='$d': rc $rc: ${out:0:120}"; done
# the only call allowed before the gate: lib.sh's own BASE read (git rev-parse, into the sandbox) at source time
bad=$(grep -v "^SHIM-CALLED git -C $SB/no-main rev-parse " $SB/shim.log 2>/dev/null)
[ -z "$bad" ] && t ok "the sandboxed og-push.sh attempted no fetch, push, gh, ssh or curl before refusing (only lib.sh's rev-parse, $(grep -c . $SB/shim.log 2>/dev/null || echo 0)x)" || t no "a shim was called: $(head -3 <<<"$bad")"
rm -rf "$SB"
echo "og-selftest: $((n-f))/$n"; [ $f = 0 ]
