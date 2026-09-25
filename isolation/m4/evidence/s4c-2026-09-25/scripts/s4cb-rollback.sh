#!/usr/bin/env bash
# 4c-b rollback: dist back to dist-iso-c42612c0, one node CVM restart, checked. Gate: the 3 S0 canaries alone (chain +
# guestd), a failed read unsafe, OVERRIDE=<reason> logged; the apply's own fail() passes its one-time token instead.
set -euo pipefail; source ~/enclave-bench/pool-rollout-20260925/lib.sh; source ~/enclave-bench/s4c-20260925/lib4c.sh
TOK=$EV/secret/4c-rollback-token
if [ -n "${FROM_APPLY:-}" ] && [ -f "$TOK" ] && [ "$(cat "$TOK" 2>/dev/null)" = "$FROM_APPLY" ]; then
  rm -f "$TOK"; say "4c-b ROLLBACK from the apply's own check: ${FROM_APPLY_WHY:-}"
elif [ -n "${FROM_APPLY:-}" ]; then say "REFUSING: FROM_APPLY without the apply's token"; exit 31
elif ! { check_guestd pool64 && noncanary_empty; }; then
  [ -n "${OVERRIDE:-}" ] || { say "REFUSING the 4c-b rollback: not the 3 S0 canaries alone, or a non-canary may be on metal-iso0; escalate to Codex"; exit 30; }
  say "OVERRIDE (4c-b rollback): $OVERRIDE"; { echo "$(date -u +%FT%TZ) OVERRIDE (4c-b rollback): $OVERRIDE" >> $EV/rollback-override.log; } 2>/dev/null || true
fi
[ -f "$CB4" ] || { say "no $CB4"; exit 1; }
python3 -c "import json,sys; sys.exit(0 if json.load(open('$CB4'))['dist']=='$OLDD' else 1)" || { say "the backup is not the S2 config"; exit 1; }
cp -p "$CB4" "$EV/secret/config.iso.json.new" || { say "ROLLBACK FAILED: copying the backup"; exit 22; }
mv "$EV/secret/config.iso.json.new" "$C" || { say "ROLLBACK FAILED: installing the backup"; exit 22; }
say "4c-b ROLLBACK: dist -> dist-iso-c42612c0; restarting enclave-metal-iso"
systemctl --user restart enclave-metal-iso.service || { say "ROLLBACK FAILED: the restart (the config IS restored)"; exit 22; }
attested_old() { [ "$(node_attested)" = "$OLDM $OLDC" ]; }
wait_for 600 attested_old || { say "ROLLBACK CHECK FAILED: the node does not attest 10622d98 / c42612c0 again"; exit 21; }
wait_for 300 public_ok || { say "ROLLBACK CHECK FAILED: canaries"; exit 21; }
mv "$CB4" "$CB4.used-$(date -u +%Y%m%dT%H%M%SZ)" || say "note: the used backup could not be renamed"
say "4c-b ROLLED BACK and checked (the node attests 10622d98, overlay c42612c0)"
