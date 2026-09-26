#!/usr/bin/env bash
# Rollback of S9 (s9t-apply.sh): the pre-switch unit back, i.e. BOTH the binary and the tree AND S8's naming flags:
# guestd.0c087de8 (fda353c9) -release on iso-0c087de8 (release 5db18199) with -isolation-release @release-0c087de8,
# -legacy-isolation-release (unchanged) and -unrecorded-releases f7888d86,5c3561f9,6f14ce75 (S8's line, byte-exact from
# the backup), one restart, checked. Derived from s8t-rollback.sh v6 (bf GO), its guards re-pointed one release on.
# A canary already relaunched onto aee2059f (e8): the old guestd re-adopts it with iso-0c087de8's judge naming its
# recorded [aee2059f]; that judge has no seccomp table and ignores the seccomp= key, and aee2059f is not in its
# LEGACY_WX_RELEASES, so the attest-time W^X form is required - which aee2059f states. From source, not tested.
# Gate: guestd holds exactly the 3 canaries with their CURRENT keys (lib9.sh) and no non-canary; OVERRIDE=<reason> logged;
# the apply's own fail() passes its one-time token instead. After any e8 relaunch the keys differ: OVERRIDE,
# and the post-checks on the pre-e8 keys then report CHECK FAILED for the relaunched canary by construction.
# AFTER THE RELAY RETIRES 5db18199 (rs-12): never run this alone (the guard below refuses): roll rs-12 back FIRST.
set -euo pipefail; source ~/enclave-bench/pool-rollout-20260925/lib.sh; source ~/enclave-bench/e7-20260926/lib-e7.sh; source ~/enclave-bench/s9-20260926/lib9.sh
# enclave-bf: lib9.sh is sourced LAST (lib-e7.sh sets REL/LOG4/say for e7), and REL and LOG4 are re-pinned and REL
# asserted against the installed release, so no later source can clobber the release this switch is about
REL=aee2059ffcc7bd8a459001cba02a7e9139d6a4aa964fd6de68047407f8597532; LOG4=$S4/install.log
[ "$(sha256sum < "$R/release.json" | cut -c1-64)" = "$REL" ] && [ "$T" = /home/steven/enclave-prod/iso-4cd26e58 ] && [ "$OT" = /home/steven/enclave-prod/iso-0c087de8 ] || { echo "REFUSING: REL/T/OT are not the S9 switch's"; exit 2; }
B4=$OBIN   # guestd.0c087de8, OT = iso-0c087de8 (lib9.sh)
[ "$B4" = /home/steven/enclave-prod/bin/guestd.0c087de8 ] && [ -x "$B4" ] && [ "$(sha256sum < "$B4" | cut -c1-64)" = "$OBSHA" ] \
  || { echo "REFUSING: the rollback binary $B4 is missing or not $OBSHA"; exit 1; }
BAK=$EV/secret/enclave-guestd.service.bak-pre-9t; TOK=$EV/secret/9t-rollback-token
if [ -n "${FROM_APPLY:-}" ] && [ -f "$TOK" ] && [ "$(cat "$TOK" 2>/dev/null)" = "$FROM_APPLY" ]; then
  rm -f "$TOK"; say4 "9T ROLLBACK from the apply's own check (gate verified by its preflight): ${FROM_APPLY_WHY:-}"
elif [ -n "${FROM_APPLY:-}" ]; then
  say4 "REFUSING: FROM_APPLY without the apply's token (a stale variable?); run without it (gated) or with OVERRIDE"; exit 31
elif ! { check_guestd4 >/dev/null && noncanary_empty; }; then
  [ -n "${OVERRIDE:-}" ] || { say4 "REFUSING the tree-switch rollback: a guest is not one of the 3 canaries on its current key ($KEYS4), or a non-canary is (or may be) on metal-iso0; escalate to enclave-87"; exit 30; }
  say4 "OVERRIDE (9t rollback): $OVERRIDE"; { echo "$(date -u +%FT%TZ) OVERRIDE (9t rollback): $OVERRIDE" >> $EV/rollback-override.log; } 2>/dev/null || true
fi
# ---- enclave-87 (S8's enforced guard, one release on): this rollback returns guestd to iso-0c087de8, which builds 5db18199
# guests; once the relay retires 5db18199 (rs-12) those guests get no release and no certificate. So the relay's PUBLIC
# /v1/expected-guest must list 5db18199 releaseAdmitted for EVERY canary (i.e. rs-12 not run, or rolled back first); an unreadable
# or malformed answer, or one for another id, counts as NOT admitted (fail closed). Its own bypass, OVERRIDE_UNADMITTED:
# OVERRIDE alone cannot pass it (every rollback after e7 needs OVERRIDE for the canary gate). The apply's own fail()
# (FROM_APPLY, token-checked above) is exempt: it runs mid-switch, where a half-switched unit is worse; S8 has run and
# s9t-apply.sh refuses a re-run while $BAK exists. test-rollback-guard.sh runs this block verbatim.
# BEGIN 5db18199-admitted guard
adm_5db18199() {   # the canary ids are HARD-CODED here (enclave-bf): a new canary set makes this refuse (fail closed) until updated
  local cid eg
  for cid in 0x0ddbd82423a22883aca0862dc30f7320337e451bc126455cbe4d7846972c2e76 0x395bed3e2e24efa02ba9dfed4aa8e081b064e7b5652b3e6474f11c21ae7f1595 0x4e62e60da567ca6c0b35f818192813e082149e738ad27204b5f074ed8adc6c1e; do
    eg=$(curl -sS --max-time 30 "https://api.enclave.host/v1/expected-guest?id=$cid" 2>/dev/null) || return 1
    python3 -c "import json,sys; r=json.loads(sys.argv[1]); assert r.get('id','').lower()==sys.argv[2]; sys.exit(0 if any(i.get('release')==sys.argv[3] and i.get('releaseAdmitted') is True for i in r.get('images',[])) else 1)" \
      "$eg" "$cid" 5db18199ef0d321ea9dc8c81e385cb057efd05c2ef5d29e471b81fb2b78c2a77 2>/dev/null || return 1
  done
}
if [ -n "${FROM_APPLY:-}" ]; then
  :   # the apply's own automatic rollback, mid-switch (see above)
elif [ -n "${OVERRIDE_UNADMITTED:-}" ]; then
  say4 "OVERRIDE_UNADMITTED (9t rollback, 5db18199 admission not checked): $OVERRIDE_UNADMITTED"
  { echo "$(date -u +%FT%TZ) OVERRIDE_UNADMITTED (9t rollback): $OVERRIDE_UNADMITTED" >> $EV/rollback-override.log; } 2>/dev/null || true
elif ! adm_5db18199; then
  say4 "REFUSING the S9 rollback: the relay does not list 5db18199 releaseAdmitted for every canary (rs-12 retired it, or the relay did not answer). Roll back rs-12 FIRST (re-admit 5db18199), then run this again; otherwise fix forward on aee2059f. Bypass only with OVERRIDE_UNADMITTED=<reason> (enclave-87)"
  exit 32
fi
# END 5db18199-admitted guard
[ -f "$BAK" ] || { say4 "no $BAK"; exit 1; }
grep -qF "ExecStart=$B4 -isolation $OT/isolation " "$BAK" && grep -qF " -guest-mem-mib 65536 -guest-cpus 16 -release -legacy-isolation $LEG -instance-prefix gd -guest-host-floor-mib $FLOOR -isolation-release $OISOREL_ARG -legacy-isolation-release $LEGREL_ARG -unrecorded-releases $OUNREC" "$BAK" \
  || { say4 "the backup is not S8's guestd.0c087de8 / iso-0c087de8 unit with its three naming flags"; exit 1; }
cp -p "$BAK" "$U.new" || { say4 "ROLLBACK FAILED: copying the backup unit"; exit 22; }
mv "$U.new" "$U" || { say4 "ROLLBACK FAILED: installing the backup unit"; exit 22; }
T0=$(date -u '+%Y-%m-%d %H:%M:%S UTC'); say4 "9T ROLLBACK: daemon-reload + restart to S8's guestd.0c087de8 / iso-0c087de8 unit"
systemctl --user daemon-reload || { say4 "ROLLBACK FAILED: daemon-reload (the unit file IS restored)"; exit 22; }
systemctl --user restart enclave-guestd.service || { say4 "ROLLBACK FAILED: restart (the unit file IS restored)"; exit 22; }
# the S9 epoch (fl-20260926/state/s9-switched-epoch) means "guestd is guestd.4cd26e58 building aee2059f": fl-check's switch
# guard reads it (and e3's rs-11 rollback guard, if it keys on it). So it goes only once the OLD unit is live (path, tree,
# S8's release flag and -unrecorded-releases back); a rollback that fails before that keeps it
X=$(systemctl --user show enclave-guestd.service -p ExecStart --value) || { say4 "ROLLBACK FAILED: ExecStart unreadable after the restart (the S9 epoch is KEPT)"; exit 22; }
grep -Fq -- "path=$B4 ;" <<<"$X" && grep -Fq -- " -isolation $OT/isolation " <<<"$X" && grep -Fq -- " -isolation-release $OISOREL_ARG " <<<"$X" && grep -Fq -- " -unrecorded-releases $OUNREC" <<<"$X" \
  || { say4 "ROLLBACK FAILED: the live ExecStart is not S8's guestd.0c087de8 on iso-0c087de8 line (the S9 epoch is KEPT)"; exit 22; }
rm -f ~/enclave-bench/fl-20260926/state/s9-switched-epoch || { say4 "ROLLBACK FAILED: the S9 epoch could not be removed"; exit 22; }
say4 "9T ROLLBACK: S8's guestd.0c087de8 on iso-0c087de8 is the live unit; the S9 epoch is removed (new guests are 5db18199 again)"
wait_for 300 check_guestd4 || { say4 "ROLLBACK CHECK FAILED: guestd not back at 65536/1600 with the 3 canaries on their current keys ($KEYS4)"; exit 21; }
python3 -c "import json,sys; h=json.load(open('$ST/.guestd.json'))[0]['body']; s=h.get('supports',{}); p=(h.get('pool') or {}).get('host') or {}; sys.exit(0 if s.get('release') is True and p.get('floorMiB')==$FLOOR else 1)" \
  || { say4 "ROLLBACK CHECK FAILED: not the -release guestd with the 16 GiB floor"; exit 21; }
[ "$(systemctl --user show enclave-guestd.service -p NRestarts --value)" = 0 ] || { say4 "ROLLBACK CHECK FAILED: restarts"; exit 21; }
RJ=$S4/8t-rollback-journal.txt; journalctl --user -u enclave-guestd.service --since "$T0" --no-pager -o cat > "$RJ" 2>&1 || true
grep -qF "adopted 3 guest(s)" "$RJ" || { say4 "ROLLBACK CHECK FAILED: no adoption line"; exit 21; }
wait_for 120 public_ok4 || { say4 "ROLLBACK CHECK FAILED: canaries (current keys, $KEYS4)"; exit 21; }
mv "$BAK" "$BAK.used-$(date -u +%Y%m%dT%H%M%SZ)" || say4 "note: the used backup could not be renamed (the rollback itself is done)"
say4 "9T ROLLED BACK to S8's guestd.0c087de8 / iso-0c087de8 unit and checked"
