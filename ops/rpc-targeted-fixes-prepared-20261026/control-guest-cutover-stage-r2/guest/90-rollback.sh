#!/usr/bin/env bash
# Undo ONE apply run from its phase journal, newest step first: restore each backed-up release file only if the backup equals
# the baseline hash, remove only files/dirs that run created, remove only the drop-in whose hash that run installed. Then
# daemon-reload, restart if that run restarted, and verify against the baseline. Deletes nothing else; backups are kept.
#   90-rollback.sh <baseline dir> <run dir>      exit 0 rolled back and verified | 8 ROLLBACK FAILED
. "$(dirname "$0")/lib.sh"
B=${1:?baseline} RUN=${2:?run dir}; J=$RUN/phase.journal
failed() { say "ROLLBACK FAILED: $*. Nothing was deleted: backups $RUN/files, journal $J"; printf 'DECISION rollback-failed\n' >> "$J" 2>/dev/null || true; exit $RC_ROLLBACK_FAILED; }
[ -f "$J" ] || failed "no phase journal"
baseline_ok "$B" || failed "baseline $B missing or altered: backups cannot be validated"
[ "$(sed -n 's/^begin //p' "$J")" = "$B" ] || failed "the journal is not a run of baseline $B"
grep -qE '^DECISION (committed|rolled-back)$' "$J" && failed "the run is already decided ($(grep '^DECISION' "$J" | tail -n 1))"
printf 'rollback-start -\n' >> "$J"
bad=0; tac "$J" > "$RUN/undo"
while read -r step arg; do case $step in
  file) bs=$(awk -v f="$arg" '$2==f{print $1}' "$B/release.sha256")
        if [ -z "$bs" ] || [ ! -f "$RUN/files/$arg" ] || [ "$(fsha "$RUN/files/$arg")" != "$bs" ]; then say "backup of $arg does not equal the baseline hash: NOT restored"; bad=1; continue; fi
        rm -f "$LIVE/$arg.cutover-tmp"
        if cp -a "$RUN/files/$arg" "$LIVE/$arg.rollback-tmp" && mv -fT "$LIVE/$arg.rollback-tmp" "$LIVE/$arg" && [ "$(fsha "$LIVE/$arg")" = "$bs" ]; then say "restored $arg"
        else rm -f "$LIVE/$arg.rollback-tmp"; say "could not restore $arg"; bad=1; fi ;;
  new)  if grep -qE "^[0-9a-f]{64}  $arg\$" "$B/release.sha256"; then say "$arg is in the baseline: NOT removed"; bad=1; continue; fi
        rm -f "$LIVE/$arg.cutover-tmp" "$LIVE/$arg" && say "removed new $arg" || bad=1 ;;
  mkdir) rmdir "$LIVE/$arg" 2>/dev/null || { say "cannot remove created dir $arg"; bad=1; } ;;
  dropin) rm -f "$DROPIN.cutover-tmp"
        if [ -e "$DROPIN" ] || [ -L "$DROPIN" ]; then
          if [ -f "$DROPIN" ] && [ ! -L "$DROPIN" ] && [ "$(fsha "$DROPIN")" = "$arg" ]; then rm -f "$DROPIN" && say "removed the run's drop-in" || bad=1
          else say "$DROPIN is not the file this run installed: NOT removed"; bad=1; fi; fi ;;
  mkdir-dropd) rmdir "$DROPD" 2>/dev/null || { say "cannot remove created $DROPD"; bad=1; } ;;
esac; done < "$RUN/undo"
[ $bad = 0 ] || failed "files could not be restored exactly (unit NOT restarted)"
systemctl daemon-reload || failed "daemon-reload"
if grep -q '^restart ' "$J"; then
  before=$(unit_inv || echo none)
  systemctl restart $UNIT || failed "restart of $UNIT"
  sleep "$SETTLE"; after=$(unit_inv) || failed "no InvocationID after restart"
  [ "$after" != "$before" ] || failed "InvocationID unchanged: the restart did not happen"
else after=$(unit_inv) || failed "no InvocationID"; [ "$after" = "$(sed -n 's/^invocation-before //p' "$J")" ] || failed "the unit was restarted outside this run"; fi
systemctl is-active --quiet $UNIT || failed "$UNIT not active"
diff <(live_manifest) "$B/release.sha256" >/dev/null || failed "live release != baseline release manifest"
diff <(dropins_manifest) "$B/dropins.sha256" >/dev/null || failed "drop-in dir != baseline"
now=$(env_hashes "$B/salt") || failed "cannot read the relay environment"
[ "$now" = "$(cat "$B/env.hashes")" ] || failed "relay env != baseline for: $(comm -3 <(printf '%s\n' "$now") "$B/env.hashes" | awk '{print $1}' | sort -u | tr '\n' ' ')"
c=$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 http://127.0.0.1:8100/v1/health || true); [ "$c" = 200 ] || failed "GET /v1/health -> $c"
printf 'rolled-back-invocation %s\nDECISION rolled-back\n' "$after" >> "$J"
say "## ROLLED BACK to $B: release, drop-ins and env values equal the baseline; invocation $after healthy"
