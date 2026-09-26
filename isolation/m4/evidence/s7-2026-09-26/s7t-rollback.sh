#!/usr/bin/env bash
# Rollback of the S7 TREE SWITCH (s7t-apply.sh): the pre-switch unit back, i.e. guestd.4e78ba80 -release on iso-4cdd5169
# (release 52156652) with the 16 GiB floor, one restart, checked. Derived from the reviewed s5t-rollback.sh. A canary
# already relaunched onto f7888d86 would be re-adopted by its recorded measurement too.
# Gate: guestd holds exactly the 3 canaries with their CURRENT (e5) keys and the chain + guestd show no non-canary; a
# failed read is unsafe; OVERRIDE=<reason> is logged. The apply's own fail() passes its one-time token instead.
# AFTER any canary is accepted on f7888d86 (e6), its key differs from e5's, so the gate REFUSES (exit 30): run it then with
# OVERRIDE=<reason> (enclave-87), and only with every relaunched canary accounted for.
set -euo pipefail; source ~/enclave-bench/pool-rollout-20260925/lib.sh; source ~/enclave-bench/e5-20260926/lib-e5.sh; source ~/enclave-bench/s7-20260926/lib7.sh
# enclave-bf: lib7.sh is sourced LAST (lib-e5.sh sets REL/LOG4/say for e5), and REL and LOG4 are re-pinned and REL
# asserted against the installed release, so no later source can clobber the release this switch is about
REL=f7888d8690845cbb862c1fbcae0a22f5458fcb891de7d0d3ae31ea927536b7ca; LOG4=$S4/install.log
[ "$(sha256sum < "$R/release.json" | cut -c1-64)" = "$REL" ] && [ "$T" = /home/steven/enclave-prod/iso-b63c2def ] && [ "$OT" = /home/steven/enclave-prod/iso-4cdd5169 ] || { echo "REFUSING: REL/T/OT are not the S5 switch's"; exit 2; }
B4=$PROD/bin/guestd.4e78ba80   # OT = iso-4cdd5169 (lib7.sh)
BAK=$EV/secret/enclave-guestd.service.bak-pre-7t; TOK=$EV/secret/7t-rollback-token
if [ -n "${FROM_APPLY:-}" ] && [ -f "$TOK" ] && [ "$(cat "$TOK" 2>/dev/null)" = "$FROM_APPLY" ]; then
  rm -f "$TOK"; say4 "7T ROLLBACK from the apply's own check (gate verified by its preflight): ${FROM_APPLY_WHY:-}"
elif [ -n "${FROM_APPLY:-}" ]; then
  say4 "REFUSING: FROM_APPLY without the apply's token (a stale variable?); run without it (gated) or with OVERRIDE"; exit 31
elif ! { check_guestd4 >/dev/null && noncanary_empty; }; then
  [ -n "${OVERRIDE:-}" ] || { say4 "REFUSING the tree-switch rollback: a guest is not one of the 3 canaries on its current (e5) key, or a non-canary is (or may be) on metal-iso0; escalate to enclave-87"; exit 30; }
  say4 "OVERRIDE (5t rollback): $OVERRIDE"; { echo "$(date -u +%FT%TZ) OVERRIDE (5t rollback): $OVERRIDE" >> $EV/rollback-override.log; } 2>/dev/null || true
fi
[ -f "$BAK" ] || { say4 "no $BAK"; exit 1; }
grep -q "^ExecStart=$B4 -isolation $OT/isolation .* -guest-mem-mib 65536 -guest-cpus 16 -release -legacy-isolation $LEG -instance-prefix gd -guest-host-floor-mib $FLOOR\$" "$BAK" \
  || { say4 "the backup is not the iso-4cdd5169 unit"; exit 1; }
rm -f ~/enclave-bench/fl-20260926/state/s7-switched-epoch   # back on iso-4cdd5169: new guests are 52156652 again (the first-launch check)
cp -p "$BAK" "$U.new" || { say4 "ROLLBACK FAILED: copying the backup unit"; exit 22; }
mv "$U.new" "$U" || { say4 "ROLLBACK FAILED: installing the backup unit"; exit 22; }
T0=$(date -u '+%Y-%m-%d %H:%M:%S UTC'); say4 "7T ROLLBACK: daemon-reload + restart to the iso-4cdd5169 unit"
systemctl --user daemon-reload || { say4 "ROLLBACK FAILED: daemon-reload (the unit file IS restored)"; exit 22; }
systemctl --user restart enclave-guestd.service || { say4 "ROLLBACK FAILED: restart (the unit file IS restored)"; exit 22; }
wait_for 300 check_guestd4 || { say4 "ROLLBACK CHECK FAILED: guestd not back at 65536/1600 with the 3 canaries on their current (e5) keys"; exit 21; }
python3 -c "import json,sys; h=json.load(open('$ST/.guestd.json'))[0]['body']; s=h.get('supports',{}); p=(h.get('pool') or {}).get('host') or {}; sys.exit(0 if s.get('release') is True and p.get('floorMiB')==$FLOOR else 1)" \
  || { say4 "ROLLBACK CHECK FAILED: not the -release guestd with the 16 GiB floor"; exit 21; }
[ "$(systemctl --user show enclave-guestd.service -p NRestarts --value)" = 0 ] || { say4 "ROLLBACK CHECK FAILED: restarts"; exit 21; }
RJ=$S4/7t-rollback-journal.txt; journalctl --user -u enclave-guestd.service --since "$T0" --no-pager -o cat > "$RJ" 2>&1 || true
grep -qF "adopted 3 guest(s)" "$RJ" || { say4 "ROLLBACK CHECK FAILED: no adoption line"; exit 21; }
wait_for 120 public_ok4 || { say4 "ROLLBACK CHECK FAILED: canaries (current e5 keys)"; exit 21; }
mv "$BAK" "$BAK.used-$(date -u +%Y%m%dT%H%M%SZ)" || say4 "note: the used backup could not be renamed (the rollback itself is done)"
say4 "7T ROLLED BACK to the iso-4cdd5169 unit and checked"
