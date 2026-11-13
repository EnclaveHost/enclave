#!/bin/bash
# The operator's one command for moving Enclave RPC from r13 to r14 (1.4.0: logs no longer kept in guest memory,
# memory limits as shares of the guest, a memory report and a working-set probe).
#
#   bash ops/rpc-snp-prod-r7/release-r14/run-cutover.sh
#
# 1. host-prepare.sh manager: the VM manager binds image r14 for the next launch (the running guest is not touched)
# 2. waits while the owner signs the three steps on the signing page (publish, stop, start), then finish.sh
# Enclave RPC is down from the stop until the r14 guest's clients are back at head. Every part skips what is already
# done; run it again after fixing whatever stopped it.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd); REPO=$(cd "$HERE/../../.." && pwd)
RELEASE=/vm/enclave-volumes/rpc-snp-release-r14
PAGE=http://127.0.0.1:42293

bash "$HERE/host-prepare.sh" manager "$REPO"

if ! curl -s -m 5 -o /dev/null "$PAGE/plan"; then
  systemd-run --user --unit=enclave-rpc-owner-sign-r14 --collect -p WorkingDirectory="$REPO" /usr/bin/node rpc/snp/owner-sign/server.mjs "$RELEASE/PLAN.json" 42293
  sleep 3
fi
echo
echo "Now sign the three steps at $PAGE (publish, stop, then start once the page offers it)."
echo "This terminal follows along and finishes the move after the start transaction."
echo
bash "$HERE/finish.sh" "$PAGE/status" "$RELEASE/cvm.sh"
