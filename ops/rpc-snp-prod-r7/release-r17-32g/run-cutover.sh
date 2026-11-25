#!/bin/bash
# The operator's one command for bringing Enclave RPC up as 1.5.1: image r17, whose only change from r15 is that
# Base's state history rolls in a 7,000,000-block window (base_state_history_patch.py), in a 32 GiB guest as before.
# The deployment is on version 9 (1.5.0, image r16) and down: that image was stopped before Base ran. README.md
# beside this file has the record.
#
#   bash ops/rpc-snp-prod-r7/release-r17-32g/run-cutover.sh
#
# 1. host-prepare.sh manager: the VM manager binds image r17 for the next launch (the running guest is not touched)
# 2. waits while the owner signs the three steps on the signing page (publish, stop, start), then finish.sh
# Ethereum and Base are down from the stop until the r17 guest's clients are back at head. Every part skips what is already
# done; run it again after fixing whatever stopped it.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd); REPO=$(cd "$HERE/../../.." && pwd)
RELEASE=/vm/enclave-volumes/rpc-snp-release-r17-32g
# metal0's control VM moved since cvm.sh was written; its address there is stale
export CVM_IP=${CVM_IP:-172.25.202.35}
PAGE=http://127.0.0.1:42300

bash "$HERE/host-prepare.sh" manager "$REPO"

if ! curl -s -m 5 -o /dev/null "$PAGE/plan"; then
  systemd-run --user --unit=enclave-rpc-owner-sign-r17-32g --collect -p WorkingDirectory="$REPO" /usr/bin/node rpc/snp/owner-sign/server.mjs "$RELEASE/PLAN.json" 42300
  sleep 3
fi
echo
echo "Now sign the three steps at $PAGE (publish, stop, then start once the page offers it)."
echo "This terminal follows along and finishes the move after the start transaction."
echo
bash "$HERE/finish.sh" "$PAGE/status" /vm/enclave-volumes/rpc-snp-release-r14/cvm.sh
