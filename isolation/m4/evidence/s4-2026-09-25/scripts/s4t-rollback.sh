#!/usr/bin/env bash
# Rollback of the S4 TREE SWITCH (s4t-apply.sh): the pre-switch unit back, i.e. the 4d unit (guestd.4e78ba80 -release on
# iso-17e182a8 with the 16 GiB floor), one restart, checked. The deeper rollback (to guestd.c42612c0) stays
# s4d-rollback.sh, and runs only after this one. A RELEASE guest must be deleted first: none may exist before the switch.
# Gate: guestd holds exactly the 3 S0 canaries with their S0 keys and the chain + guestd show no non-canary; a failed
# read is unsafe; OVERRIDE=<reason> is logged. The apply's own fail() passes its one-time token instead.
set -euo pipefail; source ~/enclave-bench/pool-rollout-20260925/lib.sh; source ~/enclave-bench/pool-rollout-20260925/s4/lib4.sh
OT=$PROD/iso-17e182a8; B4=$PROD/bin/guestd.4e78ba80
BAK=$EV/secret/enclave-guestd.service.bak-pre-4t; TOK=$EV/secret/4t-rollback-token
if [ -n "${FROM_APPLY:-}" ] && [ -f "$TOK" ] && [ "$(cat "$TOK" 2>/dev/null)" = "$FROM_APPLY" ]; then
  rm -f "$TOK"; say4 "4T ROLLBACK from the apply's own check (gate verified by its preflight): ${FROM_APPLY_WHY:-}"
elif [ -n "${FROM_APPLY:-}" ]; then
  say4 "REFUSING: FROM_APPLY without the apply's token (a stale variable?); run without it (gated) or with OVERRIDE"; exit 31
elif ! { check_guestd pool64 && noncanary_empty; }; then
  [ -n "${OVERRIDE:-}" ] || { say4 "REFUSING the tree-switch rollback: a guest is not one of the 3 S0 canaries, or a non-canary is (or may be) on metal-iso0; escalate to Codex"; exit 30; }
  say4 "OVERRIDE (4t rollback): $OVERRIDE"; { echo "$(date -u +%FT%TZ) OVERRIDE (4t rollback): $OVERRIDE" >> $EV/rollback-override.log; } 2>/dev/null || true
fi
[ -f "$BAK" ] || { say4 "no $BAK"; exit 1; }
grep -q "^ExecStart=$B4 -isolation $OT/isolation .* -guest-mem-mib 65536 -guest-cpus 16 -release -legacy-isolation $LEG -instance-prefix gd -guest-host-floor-mib $FLOOR\$" "$BAK" \
  || { say4 "the backup is not the 4d unit"; exit 1; }
cp -p "$BAK" "$U.new" || { say4 "ROLLBACK FAILED: copying the backup unit"; exit 22; }
mv "$U.new" "$U" || { say4 "ROLLBACK FAILED: installing the backup unit"; exit 22; }
T0=$(date -u '+%Y-%m-%d %H:%M:%S UTC'); say4 "4T ROLLBACK: daemon-reload + restart to the 4d unit (iso-17e182a8)"
systemctl --user daemon-reload || { say4 "ROLLBACK FAILED: daemon-reload (the unit file IS restored)"; exit 22; }
systemctl --user restart enclave-guestd.service || { say4 "ROLLBACK FAILED: restart (the unit file IS restored)"; exit 22; }
wait_for 300 check_guestd pool64 || { say4 "ROLLBACK CHECK FAILED: guestd not back at 65536/1600 with the 3 canaries"; exit 21; }
python3 -c "import json,sys; h=json.load(open('$EV/.guestd.json'))[0]['body']; s=h.get('supports',{}); p=(h.get('pool') or {}).get('host') or {}; sys.exit(0 if s.get('release') is True and p.get('floorMiB')==$FLOOR else 1)" \
  || { say4 "ROLLBACK CHECK FAILED: not the 4d guestd (release, floor)"; exit 21; }
[ "$(systemctl --user show enclave-guestd.service -p NRestarts --value)" = 0 ] || { say4 "ROLLBACK CHECK FAILED: restarts"; exit 21; }
RJ=$S4/4t-rollback-journal.txt; journalctl --user -u enclave-guestd.service --since "$T0" --no-pager -o cat > "$RJ" 2>&1 || true
grep -qF "adopted 3 guest(s)" "$RJ" || { say4 "ROLLBACK CHECK FAILED: no adoption line"; exit 21; }
wait_for 120 public_ok || { say4 "ROLLBACK CHECK FAILED: canaries"; exit 21; }
mv "$BAK" "$BAK.used-$(date -u +%Y%m%dT%H%M%SZ)" || say4 "note: the used backup could not be renamed (the rollback itself is done)"
say4 "4T ROLLED BACK to the 4d unit (iso-17e182a8) and checked"
