#!/usr/bin/env bash
# Rollback of 4d: the pre-4d unit back (guestd.c42612c0, -isolation iso-03be27d6, no -release/-legacy-isolation/floor),
# one restart, checked. INSTALL.md section 4: a guest launched under 4d is a 0181bce3 image the old guestd adopts, but a
# RELEASE guest (possible only after rows 7-8) must be deleted first: the old guestd has no ticket or egress service.
# Gate (as the budget/dist rollbacks): guestd holds exactly the 3 S0 canaries with their S0 keys (so every guest was
# launched by the old guestd) and the chain + guestd show no non-canary; a failed read is unsafe; OVERRIDE=<reason> is
# logged. The apply's own fail() passes FROM_APPLY instead: its preflight checked the gate seconds before, and a failed
# 4d may leave guestd unreadable, which the gate would refuse.
set -euo pipefail; source ~/enclave-bench/pool-rollout-20260925/lib.sh; source ~/enclave-bench/pool-rollout-20260925/s4/lib4.sh
BAK=$EV/secret/enclave-guestd.service.bak-pre-4d
if [ -n "${FROM_APPLY:-}" ]; then
  say4 "4D ROLLBACK from the apply's own check (gate verified by its preflight): $FROM_APPLY"
elif ! { check_guestd pool64 && noncanary_empty; }; then
  [ -n "${OVERRIDE:-}" ] || { say4 "REFUSING the 4d rollback: a guest is not one of the 3 S0 canaries, or a non-canary is (or may be) on metal-iso0; escalate to Codex"; exit 30; }
  say4 "OVERRIDE (4d rollback): $OVERRIDE" | tee -a $EV/rollback-override.log
fi
[ -f "$BAK" ] || { say4 "no $BAK"; exit 1; }
grep -q "^ExecStart=$NEWBIN -isolation $PROD/iso-03be27d6/isolation .* -guest-mem-mib 65536 -guest-cpus 16\$" "$BAK" || { say4 "the backup is not the budget-64 unit"; exit 1; }
cp -p "$BAK" "$U.new" && mv "$U.new" "$U"
T0=$(date -u '+%Y-%m-%d %H:%M:%S UTC'); say4 "4D ROLLBACK: daemon-reload + restart to guestd.c42612c0 on the live tree"
systemctl --user daemon-reload
systemctl --user restart enclave-guestd.service
wait_for 300 check_guestd pool64 || { say4 "ROLLBACK CHECK FAILED: guestd not back at 65536/1600 with the 3 canaries"; exit 21; }
python3 -c "import json,sys; s=json.load(open('$EV/.guestd.json'))[0]['body'].get('supports',{}); sys.exit(0 if not s.get('release') else 1)" || { say4 "ROLLBACK CHECK FAILED: release still on"; exit 21; }
[ "$(systemctl --user show enclave-guestd.service -p NRestarts --value)" = 0 ] || { say4 "ROLLBACK CHECK FAILED: restarts"; exit 21; }
journalctl --user -u enclave-guestd.service --since "$T0" --no-pager -o cat | grep -qF "adopted 3 guest(s)" || { say4 "ROLLBACK CHECK FAILED: no adoption line"; exit 21; }
wait_for 120 public_ok || { say4 "ROLLBACK CHECK FAILED: canaries"; exit 21; }
mv "$BAK" "$BAK.used-$(date -u +%Y%m%dT%H%M%SZ)"; say4 "4D ROLLED BACK to guestd.c42612c0 and checked"
