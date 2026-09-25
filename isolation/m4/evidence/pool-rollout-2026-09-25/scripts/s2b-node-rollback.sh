#!/usr/bin/env bash
# S2b rollback: dist back to dist-iso-8ed6231f, one CVM restart. v2 (enclave-99 H2): REFUSED unless no non-canary
# deployment runs on metal-iso0, by the chain and by guestd, with a failed read counted as unsafe; OVERRIDE=<reason> logs one.
set -euo pipefail; source ~/enclave-bench/pool-rollout-20260925/lib.sh
if ! noncanary_empty; then
  [ -n "${OVERRIDE:-}" ] || { say "REFUSING the S2b rollback: a non-canary deployment is (or may be) on metal-iso0; escalate to Codex"; exit 30; }
  say "NON-CANARY OVERRIDE: $OVERRIDE" | tee -a $EV/rollback-override.log
fi
[ -f "$CBAK" ] || { say "no $CBAK"; exit 1; }
python3 -c "import json,sys; sys.exit(0 if json.load(open('$CBAK'))['dist']=='$OLDD' else 1)" || { say "the backup is not the S0 config"; exit 1; }
cp -p "$CBAK" "$EV/secret/config.iso.json.new" && mv "$EV/secret/config.iso.json.new" "$C"
say "S2b ROLLBACK: dist -> dist-iso-8ed6231f; restarting enclave-metal-iso"
systemctl --user restart enclave-metal-iso.service
attested_old() { [ "$(node_attested)" = "$OLDM 8ed6231fea2ccb75f55f301a2c1803633497d48c" ]; }
wait_for 600 attested_old || { say "ROLLBACK CHECK FAILED: the node does not attest 04e953a4 again"; exit 21; }
wait_for 300 public_ok || { say "ROLLBACK CHECK FAILED: canaries"; exit 21; }
mv "$CBAK" "$CBAK.used-$(date -u +%Y%m%dT%H%M%SZ)"; say "S2b ROLLED BACK and checked (the node attests 04e953a4, overlay 8ed6231f)"
