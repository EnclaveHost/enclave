#!/bin/bash
# The operator's one command for moving Enclave RPC from r14 to r15 (1.4.2: Base starts again after the L1 node has
# pruned the snapshot origin's safe block; nothing else in the image changes, and the guest stays at 48 GiB).
#
#   bash ops/rpc-snp-prod-r7/release-r15/run-cutover.sh
#
# 1. host-prepare.sh manager: the VM manager binds image r15 for the next launch (the running guest is not touched)
# 2. waits while the owner signs the three steps on the signing page (publish, stop, start), then finish.sh
# Ethereum is down from the stop until the r15 guest's clients are back at head; Base is down already. Every part skips what is already
# done; run it again after fixing whatever stopped it.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd); REPO=$(cd "$HERE/../../.." && pwd)
RELEASE=/vm/enclave-volumes/rpc-snp-release-r15
# metal0's control VM moved since cvm.sh was written; its address there is stale
export CVM_IP=${CVM_IP:-172.25.202.35}
PAGE=http://127.0.0.1:42297

bash "$HERE/host-prepare.sh" manager "$REPO"

if ! curl -s -m 5 -o /dev/null "$PAGE/plan"; then
  systemd-run --user --unit=enclave-rpc-owner-sign-r15 --collect -p WorkingDirectory="$REPO" /usr/bin/node rpc/snp/owner-sign/server.mjs "$RELEASE/PLAN.json" 42297
  sleep 3
fi
echo
echo "Now sign the three steps at $PAGE (publish, stop, then start once the page offers it)."
echo "This terminal follows along and finishes the move after the start transaction."
echo
bash "$HERE/finish.sh" "$PAGE/status" /vm/enclave-volumes/rpc-snp-release-r14/cvm.sh
