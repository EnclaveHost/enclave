#!/usr/bin/env bash
# The ONLY mutating script (guest, root). Phases, each recorded in <run>/phase.journal before it acts:
#   A drift check vs the baseline (pre-activation identity)      read-only, 10-drift-check.sh
#   B qualification gates (release receipt, verifier, backend, canary protocol)   read-only, 15-gates.sh - HOLD in r2
#   C NOEXECUTE unless CUTOVER_EXECUTE=yes
#   D activation as ONE decision: back up + swap every staged release file, install the drop-in, daemon-reload, ONE restart
#   E activated-candidate identity: new InvocationID, live files == staged manifest, drop-in hash, env values, journal line
#   F canary (30-canary.sh; never passes in r2)
# Any failure in D-F rolls back release AND config together (90-rollback.sh); there is no "new release, old config" state.
#   20-apply.sh <baseline dir> <verifier url> <tx backend url> <staged release dir>
#   exit 0 committed (unreachable in r2) | 3 HOLD | 5 rolled back, baseline verified | 8 ROLLBACK FAILED | 9 mismatch | 10 NOEXECUTE
. "$(dirname "$0")/lib.sh"
B=${1:?baseline} V=${2:?verifier url} TX=${3:?tx backend url} STAGE=${4:?staged release dir}
[ -d "$STATE" ] || mismatch "no $STATE (capture a baseline first)"
exec 9>"$STATE/.lock"; flock -n 9 || { say "another cutover run holds $STATE/.lock"; exit 75; }
rc=0; bash "$HERE/10-drift-check.sh" "$B" || rc=$?; [ $rc = 0 ] || exit $rc
rc=0; bash "$HERE/15-gates.sh" "$B" "$V" "$TX" "$STAGE" || rc=$?; [ $rc = 0 ] || exit $rc
loopback_url "$V" && private_url "$TX" || mismatch "verifier/backend URL refused"     # re-checked: they are rendered below
say "PLAN: activate $(wc -l < "$STAGE/.deploy-manifest") staged release files + $DROPIN, daemon-reload, restart $UNIT once, identity, canary"
[ "${CUTOVER_EXECUTE:-no}" = yes ] || { say "NOEXECUTE: nothing changed (set CUTOVER_EXECUTE=yes to run phase D)"; exit $RC_NOEXECUTE; }

RUN=$STATE/run-$(date -u +%Y%m%dT%H%M%SZ)-$$; mkdir -m 0700 "$RUN"; mkdir -m 0700 "$RUN/files"; J=$RUN/phase.journal; : > "$J"
j() { printf '%s %s\n' "$1" "${2:--}" >> "$J"; }
decided=0   # any exit before "DECISION committed" (error, set -e, signal) runs the rollback exactly once
finish() { local r=$?; [ $decided = 0 ] || exit $r; decided=1; trap '' INT TERM
  say "[APPLY] not committed (exit $r after journal step '$(tail -n 1 "$J" | cut -d' ' -f1)'): rolling back release and config together"
  j failed "$r" || true; local b=0; bash "$HERE/90-rollback.sh" "$B" "$RUN" || b=$?
  if [ $b = 0 ]; then say "## apply NOT committed; baseline restored and verified (run $RUN)"; exit $RC_ROLLED_BACK; fi
  say "## ROLLBACK FAILED (rc $b): manual recovery from $RUN (journal, files/)"; exit $RC_ROLLBACK_FAILED; }
trap finish EXIT; trap 'exit 130' INT TERM
fail() { say "[APPLY] $*"; exit 1; }
dropin_text "$V" "$TX" > "$RUN/50-chain-authority.conf" || fail "render drop-in"; dsha=$(fsha "$RUN/50-chain-authority.conf")
inv0=$(unit_inv) || fail "no InvocationID before activation"
j begin "$B"; j invocation-before "$inv0"; j stage-manifest "$(fsha "$STAGE/.deploy-manifest")"
# phase D: release files (journal entry written BEFORE each change, so rollback always knows it)
while read -r s f; do
  d=$(dirname "$f")
  if [ "$d" != . ] && [ ! -d "$LIVE/$d" ]; then j mkdir "$d"; mkdir "$LIVE/$d" || fail "mkdir $d"; fi
  if [ -e "$LIVE/$f" ] || [ -L "$LIVE/$f" ]; then
    bs=$(awk -v f="$f" '$2==f{print $1}' "$B/release.sha256")
    [ -n "$bs" ] && [ -f "$LIVE/$f" ] && [ ! -L "$LIVE/$f" ] && [ "$(fsha "$LIVE/$f")" = "$bs" ] || fail "live $f is not its baseline file"
    mkdir -p "$RUN/files/$d" && cp -a "$LIVE/$f" "$RUN/files/$f" && [ "$(fsha "$RUN/files/$f")" = "$bs" ] || fail "backup of $f"
    j file "$f"
  else j new "$f"; fi
  cp -a "$STAGE/$f" "$LIVE/$f.cutover-tmp" && [ "$(fsha "$LIVE/$f.cutover-tmp")" = "$s" ] && mv -fT "$LIVE/$f.cutover-tmp" "$LIVE/$f" &&
    [ "$(fsha "$LIVE/$f")" = "$s" ] || fail "activate $f"
done < "$STAGE/.deploy-manifest"
j release-files-activated -
if [ ! -d "$DROPD" ]; then j mkdir-dropd -; mkdir -m 0755 "$DROPD" || fail "mkdir drop-in dir"; fi
j dropin "$dsha"
install -m 0644 "$RUN/50-chain-authority.conf" "$DROPIN.cutover-tmp" && mv -fT "$DROPIN.cutover-tmp" "$DROPIN" && [ "$(fsha "$DROPIN")" = "$dsha" ] || fail "install drop-in"
j daemon-reload -; systemctl daemon-reload || fail "daemon-reload"
j restart "$inv0"; systemctl restart $UNIT || fail "restart"
sleep "$SETTLE"
# phase E: the activated candidate's identity (never the baseline's hashes)
systemctl is-active --quiet $UNIT || fail "$UNIT not active after restart"
inv1=$(unit_inv) || fail "no InvocationID after restart"; [ "$inv1" != "$inv0" ] || fail "InvocationID unchanged: no restart happened"
j invocation-after "$inv1"
( cd "$LIVE" && sha256sum -c --quiet --strict "$STAGE/.deploy-manifest" ) >/dev/null 2>&1 || fail "live files are not the staged candidate"
[ "$(fsha "$DROPIN")" = "$dsha" ] || fail "drop-in is not the installed file"
env_check "$B" "$V" "$TX" || fail "environment identity"
inv_journal "$inv1" | grep -F "$AUTH_LINE" >/dev/null || fail "invocation $inv1 did not report the local verifier authority"
j identity-ok "$inv1"
# phase F
crc=0; bash "$HERE/30-canary.sh" "$B" "$V" "$TX" "$inv1" || crc=$?; j canary "$crc"
[ $crc = 0 ] || fail "canary rc $crc"
j DECISION committed; decided=1; say "## committed: invocation $inv1 (run $RUN)"
