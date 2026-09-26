#!/usr/bin/env bash
# N2-b rollback: config.iso.json back to the byte-exact pre-N2 backup (dist-iso-f6cbd75a; the launcher and its drop-in were
# never touched), one node CVM restart, checked. Derived from s4ccb-rollback.sh (minus the drop-in: N2-b does not move
# the launcher). Gate: the 3 canaries alone on their e7 keys (chain + guestd), a failed read unsafe, OVERRIDE=<reason>
# logged; the apply's own fail() passes its one-time token instead. The keys are the CURRENT ones (e7's, or n2acc's once
# its proofs recorded hookbin's new key; the block below). The relay must still allowlist f6cbd75a (02f6e313), else the
# node comes back ineligible: refused unless OVERRIDE_ALLOW=<reason>.
set -euo pipefail; source ~/enclave-bench/pool-rollout-20260925/lib.sh; source ~/enclave-bench/s4c-20260925/lib4cc.sh
source ~/enclave-bench/release-on-20260925/lib-ro.sh; source ~/enclave-bench/e7-20260926/lib-e7.sh; source ~/enclave-bench/n2-20260926/libn2.sh
# enclave-bf (required): the canaries' CURRENT keys. n2acc relaunches hookbin and records its new key in ITS state (a copy
# of e7's, updated when its proofs pass); once that copy differs from e7's, it is the current one, for the gate AND the
# post-checks. Before that (n2acc not run, or not past its proofs) e7's are. test-rollback-keys.sh runs this block.
# BEGIN current-keys
NAK=~/enclave-bench/n2acc-20260926/state
if [ -f "$NAK/canary-keys.txt" ] && [ -f "$NAK/canaries.tsv" ] && ! { cmp -s "$NAK/canary-keys.txt" "$KEYS4" && cmp -s "$NAK/canaries.tsv" "$TSV4"; }; then
  KEYS4=$NAK/canary-keys.txt; TSV4=$NAK/canaries.tsv
fi
# END current-keys
if [ -n "${FROM_APPLY:-}" ] && [ -f "$TOKN" ] && [ "$(cat "$TOKN" 2>/dev/null)" = "$FROM_APPLY" ]; then
  rm -f "$TOKN"; say "N2-b ROLLBACK from the apply's own check: ${FROM_APPLY_WHY:-}"
elif [ -n "${FROM_APPLY:-}" ]; then say "REFUSING: FROM_APPLY without the apply's token"; exit 31
elif ! { check_guestd4 >/dev/null && noncanary_empty; }; then
  [ -n "${OVERRIDE:-}" ] || { say "REFUSING the N2-b rollback: not the 3 canaries alone on their current keys ($KEYS4), or a non-canary may be on metal-iso0; escalate to enclave-87"; exit 30; }
  say "OVERRIDE (N2-b rollback): $OVERRIDE"; { echo "$(date -u +%FT%TZ) OVERRIDE (N2-b rollback): $OVERRIDE" >> $EV/rollback-override.log; } 2>/dev/null || true
fi
if ! allow_has "$OLDM"; then
  [ -n "${OVERRIDE_ALLOW:-}" ] || { say "REFUSING the N2-b rollback: the relay no longer allowlists f6cbd75a (${OLDM:0:12}), so the node would come back ineligible; restore the allowlist entry first"; exit 32; }
  say "OVERRIDE_ALLOW (N2-b rollback): $OVERRIDE_ALLOW"
fi
[ -f "$CBN" ] || { say "no $CBN"; exit 1; }
python3 -c "import json,sys; c=json.load(open('$CBN')); sys.exit(0 if c['dist']=='$OLDD' and c['isolation'].get('release') is True else 1)" || { say "the backup is not the pre-N2 config (dist f6cbd75a, release opt-in)"; exit 1; }
cp -p "$CBN" "$EV/secret/config.iso.json.new" || { say "ROLLBACK FAILED: copying the backup"; exit 22; }
mv "$EV/secret/config.iso.json.new" "$C" || { say "ROLLBACK FAILED: installing the backup"; exit 22; }
say "N2-b ROLLBACK: dist -> dist-iso-f6cbd75a (launcher unchanged); restarting enclave-metal-iso"
systemctl --user restart enclave-metal-iso.service || { say "ROLLBACK FAILED: the restart (the config IS restored)"; exit 22; }
wait_for 30 node_runs_from "$LW" "$LAUNCH_SHA" || { say "ROLLBACK CHECK FAILED: the node does not run the reviewed launcher from $LW"; exit 21; }
attested_old() { [ "$(node_attested)" = "$OLDM $OLDC" ]; }
wait_for 600 attested_old || { say "ROLLBACK CHECK FAILED: the node does not attest ${OLDM:0:12} / f6cbd75a again"; exit 21; }
wait_for 120 relay_row_ok || { say "ROLLBACK CHECK FAILED: the relay row"; exit 21; }
wait_for 300 public_ok4 || { say "ROLLBACK CHECK FAILED: canaries (current keys, $KEYS4)"; exit 21; }
mv "$CBN" "$CBN.used-$(date -u +%Y%m%dT%H%M%SZ)" || say "note: the used backup could not be renamed"
say "N2-b ROLLED BACK and checked (the node attests ${OLDM:0:12}, overlay f6cbd75a)"
