#!/bin/bash
# The operator's one command for moving Enclave RPC from 1.4.3 (image r15, 32 GiB) to 1.5.0: image r16, whose only
# change is that Base's state history rolls (base_state_history_patch.py), in a 24 GiB guest. README.md beside this
# file says what was measured, what was not, and the signs that 24 GiB is too small.
#
#   bash ops/rpc-snp-prod-r7/release-r16-24g/run-cutover.sh
#
# 1. host-prepare.sh manager: the VM manager binds image r16 for the next launch (the running guest is not touched)
# 2. waits while the owner signs the three steps on the signing page (publish, stop, start), then finish.sh
# Ethereum and Base are down from the stop until the r16 guest's clients are back at head. Every part skips what is already
# done; run it again after fixing whatever stopped it.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd); REPO=$(cd "$HERE/../../.." && pwd)
RELEASE=/vm/enclave-volumes/rpc-snp-release-r16-24g
# metal0's control VM moved since cvm.sh was written; its address there is stale
export CVM_IP=${CVM_IP:-172.25.202.35}
PAGE=http://127.0.0.1:42299

bash "$HERE/host-prepare.sh" manager "$REPO"

if ! curl -s -m 5 -o /dev/null "$PAGE/plan"; then
  systemd-run --user --unit=enclave-rpc-owner-sign-r16-24g --collect -p WorkingDirectory="$REPO" /usr/bin/node rpc/snp/owner-sign/server.mjs "$RELEASE/PLAN.json" 42299
  sleep 3
fi
echo
echo "Now sign the three steps at $PAGE (publish, stop, then start once the page offers it)."
echo "This terminal follows along and finishes the move after the start transaction."
echo
bash "$HERE/finish.sh" "$PAGE/status" /vm/enclave-volumes/rpc-snp-release-r14/cvm.sh
