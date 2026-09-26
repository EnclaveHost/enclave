#!/usr/bin/env bash
# The rpc-bounded window's ADDED paths (read-only; enclave-87's rule - no production push/rollback path is called on live state):
# the NucBox functions on the live relay, files_are_pc refusing before the push, and rb-push.sh's DRY gate ONLY as a SANDBOXED copy
# (MAIN redirected; git, gh, ssh and curl are logging shims that fail).
set -uo pipefail; H=$(cd "$(dirname "$0")" && pwd); source "$H/lib.sh"
n=0; f=0; t() { n=$((n+1)); if [ "$1" = ok ]; then echo "ok   $2"; else echo "FAIL $2"; f=$((f+1)); fi; }
row=$(hv_row); [[ "$row" == "hv-node true 0x"* ]] && t ok "hv_row($HV) = ${row:0:40}…" || t no "hv_row($HV) = $row"
[ "$(hv_row no-such-box)" = absent ] && t ok "hv_row(no-such-box) = absent" || t no "hv_row(no-such-box)"
inv=$($NAN "systemctl show enclave-api-relay -p InvocationID --value"); al=$(hv_attach_line "$inv")
[ -n "$al" ] && t ok "hv_attach_line(${inv:0:12}) = ${al:0:32}…" || t no "hv_attach_line(${inv:0:12}) empty"
[ -z "$(hv_attach_line "$inv" no-such-box)" ] && t ok "hv_attach_line(no-such-box) empty" || t no "hv_attach_line(no-such-box) not empty"
if files_are_pc api-relay.js secrets-release.mjs >/dev/null; then t no "files_are_pc passes BEFORE the push"; else t ok "files_are_pc refuses before the push: $(files_are_pc api-relay.js secrets-release.mjs)"; fi
SB=$(mktemp -d); mkdir -p $SB/bin; cp "$H/rb-push.sh" "$H/lib.sh" $SB/
sed -i "s#MAIN=/home/steven/Projects/enclave#MAIN=$SB/no-main#" $SB/lib.sh; grep -q "MAIN=$SB/no-main" $SB/lib.sh || t no "HARNESS: MAIN not redirected"
for c in git gh ssh curl; do printf '#!/bin/sh\necho "SHIM-CALLED %s $*" >> %s/shim.log; exit 1\n' "$c" "$SB" > $SB/bin/$c; chmod 755 $SB/bin/$c; done
for d in true " 1" yes 2; do out=$(PATH="$SB/bin:$PATH" DRY="$d" B_DIR=$SB/b bash "$SB/rb-push.sh" 2>&1); rc=$?
  [ $rc = 2 ] && grep -q "DRY must be exactly 0 or 1" <<<"$out" && t ok "SANDBOXED rb-push.sh DRY='$d' refuses at the gate (rc 2)" || t no "sandboxed rb-push.sh DRY='$d': rc $rc ${out:0:100}"; done
bad=$(grep -v "^SHIM-CALLED git -C $SB/no-main rev-parse " $SB/shim.log 2>/dev/null)
[ -z "$bad" ] && t ok "the sandboxed rb-push.sh attempted no fetch, push, gh, ssh or curl before refusing" || t no "a shim was called: $(head -2 <<<"$bad")"
rm -rf "$SB"
echo "rb-selftest: $((n-f))/$n"; [ $f = 0 ]
