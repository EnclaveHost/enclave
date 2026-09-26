#!/usr/bin/env bash
# Rollback of S8 (s8t-apply.sh): the pre-switch unit back, i.e. BOTH the binary and the tree: guestd.4e78ba80 (0ee7ed91)
# -release on iso-b63c2def (release f7888d86) with the 16 GiB floor and WITHOUT the per-release naming flags (4e78ba80
# has none: it would refuse to start with them), one restart, checked. Derived from the reviewed s7t-rollback.sh.
# A canary already relaunched onto 5db18199 by the new guestd (e7): the old guestd re-adopts it by its recorded
# measurement with the OLD tree's judge. From source, not tested: 4e78ba80's persist.go json.Unmarshal ignores the new
# record's Releases field, and iso-b63c2def's checkRuntimeSelfTest ignores the role keys (runtime= front= init=) of the
# attest-time form (it needs exec_pages, wx=clean, maps>=1 and a known scope; the rest is unchanged by 0c087de8).
# Gate: guestd holds exactly the 3 canaries with their CURRENT (e6) keys and the chain + guestd show no non-canary; a
# failed read is unsafe; OVERRIDE=<reason> is logged. The apply's own fail() passes its one-time token instead.
# AFTER any canary is accepted on 5db18199 (e7), its key differs from e6's, so the gate REFUSES (exit 30): run it then with
# OVERRIDE=<reason> (enclave-87), and only with every relaunched canary accounted for; the post-checks below are on the
# e6 keys, so they then report CHECK FAILED for the relaunched canary by construction: check that one by hand.
set -euo pipefail; source ~/enclave-bench/pool-rollout-20260925/lib.sh; source ~/enclave-bench/e6-20260926/lib-e6.sh; source ~/enclave-bench/s8-20260926/lib8.sh
# enclave-bf: lib8.sh is sourced LAST (lib-e6.sh sets REL/LOG4/say for e6), and REL and LOG4 are re-pinned and REL
# asserted against the installed release, so no later source can clobber the release this switch is about
REL=5db18199ef0d321ea9dc8c81e385cb057efd05c2ef5d29e471b81fb2b78c2a77; LOG4=$S4/install.log
[ "$(sha256sum < "$R/release.json" | cut -c1-64)" = "$REL" ] && [ "$T" = /home/steven/enclave-prod/iso-0c087de8 ] && [ "$OT" = /home/steven/enclave-prod/iso-b63c2def ] || { echo "REFUSING: REL/T/OT are not the S8 switch's"; exit 2; }
B4=$OBIN   # guestd.4e78ba80, OT = iso-b63c2def (lib8.sh)
[ "$B4" = /home/steven/enclave-prod/bin/guestd.4e78ba80 ] && [ -x "$B4" ] && [ "$(sha256sum < "$B4" | cut -c1-64)" = "$OBSHA" ] \
  || { echo "REFUSING: the rollback binary $B4 is missing or not $OBSHA"; exit 1; }
BAK=$EV/secret/enclave-guestd.service.bak-pre-8t; TOK=$EV/secret/8t-rollback-token
if [ -n "${FROM_APPLY:-}" ] && [ -f "$TOK" ] && [ "$(cat "$TOK" 2>/dev/null)" = "$FROM_APPLY" ]; then
  rm -f "$TOK"; say4 "8T ROLLBACK from the apply's own check (gate verified by its preflight): ${FROM_APPLY_WHY:-}"
elif [ -n "${FROM_APPLY:-}" ]; then
  say4 "REFUSING: FROM_APPLY without the apply's token (a stale variable?); run without it (gated) or with OVERRIDE"; exit 31
elif ! { check_guestd4 >/dev/null && noncanary_empty; }; then
  [ -n "${OVERRIDE:-}" ] || { say4 "REFUSING the tree-switch rollback: a guest is not one of the 3 canaries on its current (e6) key, or a non-canary is (or may be) on metal-iso0; escalate to enclave-87"; exit 30; }
  say4 "OVERRIDE (8t rollback): $OVERRIDE"; { echo "$(date -u +%FT%TZ) OVERRIDE (8t rollback): $OVERRIDE" >> $EV/rollback-override.log; } 2>/dev/null || true
fi
[ -f "$BAK" ] || { say4 "no $BAK"; exit 1; }
grep -q "^ExecStart=$B4 -isolation $OT/isolation .* -guest-mem-mib 65536 -guest-cpus 16 -release -legacy-isolation $LEG -instance-prefix gd -guest-host-floor-mib $FLOOR\$" "$BAK" \
  || { say4 "the backup is not the guestd.4e78ba80 / iso-b63c2def unit"; exit 1; }
! grep -qE -- '-isolation-release|-unrecorded-releases' "$BAK" || { say4 "the backup carries a per-release flag (4e78ba80 has none)"; exit 1; }
cp -p "$BAK" "$U.new" || { say4 "ROLLBACK FAILED: copying the backup unit"; exit 22; }
mv "$U.new" "$U" || { say4 "ROLLBACK FAILED: installing the backup unit"; exit 22; }
T0=$(date -u '+%Y-%m-%d %H:%M:%S UTC'); say4 "8T ROLLBACK: daemon-reload + restart to the guestd.4e78ba80 / iso-b63c2def unit"
systemctl --user daemon-reload || { say4 "ROLLBACK FAILED: daemon-reload (the unit file IS restored)"; exit 22; }
systemctl --user restart enclave-guestd.service || { say4 "ROLLBACK FAILED: restart (the unit file IS restored)"; exit 22; }
# the S8 epoch (fl-20260926/state/s8-switched-epoch) means "guestd is guestd.0c087de8 building 5db18199": fl-check's switch
# guard reads it, and e3's rs-9 rollback guard REFUSES while it exists. So it goes only once the OLD unit is the live one
# (path, tree, no per-release flag); a rollback that fails before that keeps it, and rs-9 stays un-rollbackable
X=$(systemctl --user show enclave-guestd.service -p ExecStart --value) || { say4 "ROLLBACK FAILED: ExecStart unreadable after the restart (the S8 epoch is KEPT)"; exit 22; }
grep -Fq -- "path=$B4 ;" <<<"$X" && grep -Fq -- " -isolation $OT/isolation " <<<"$X" && ! grep -qE -- '-isolation-release|-unrecorded-releases' <<<"$X" \
  || { say4 "ROLLBACK FAILED: the live ExecStart is not guestd.4e78ba80 on iso-b63c2def without per-release flags (the S8 epoch is KEPT)"; exit 22; }
rm -f ~/enclave-bench/fl-20260926/state/s8-switched-epoch || { say4 "ROLLBACK FAILED: the S8 epoch could not be removed"; exit 22; }
say4 "8T ROLLBACK: guestd.4e78ba80 on iso-b63c2def is the live unit; the S8 epoch is removed (new guests are f7888d86 again)"
wait_for 300 check_guestd4 || { say4 "ROLLBACK CHECK FAILED: guestd not back at 65536/1600 with the 3 canaries on their current (e6) keys"; exit 21; }
python3 -c "import json,sys; h=json.load(open('$ST/.guestd.json'))[0]['body']; s=h.get('supports',{}); p=(h.get('pool') or {}).get('host') or {}; sys.exit(0 if s.get('release') is True and p.get('floorMiB')==$FLOOR else 1)" \
  || { say4 "ROLLBACK CHECK FAILED: not the -release guestd with the 16 GiB floor"; exit 21; }
[ "$(systemctl --user show enclave-guestd.service -p NRestarts --value)" = 0 ] || { say4 "ROLLBACK CHECK FAILED: restarts"; exit 21; }
RJ=$S4/8t-rollback-journal.txt; journalctl --user -u enclave-guestd.service --since "$T0" --no-pager -o cat > "$RJ" 2>&1 || true
grep -qF "adopted 3 guest(s)" "$RJ" || { say4 "ROLLBACK CHECK FAILED: no adoption line"; exit 21; }
wait_for 120 public_ok4 || { say4 "ROLLBACK CHECK FAILED: canaries (current e6 keys)"; exit 21; }
mv "$BAK" "$BAK.used-$(date -u +%Y%m%dT%H%M%SZ)" || say4 "note: the used backup could not be renamed (the rollback itself is done)"
say4 "8T ROLLED BACK to the guestd.4e78ba80 / iso-b63c2def unit and checked"
