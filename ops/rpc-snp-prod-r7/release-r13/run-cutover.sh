#!/bin/bash
# The operator's one command for moving Enclave RPC from r12 to r13 (1.3.0: an app address, a web page, an Open link).
#
#   bash ops/rpc-snp-prod-r7/release-r13/run-cutover.sh
#
# 1. host-prepare.sh all: network agent + reconciler that route a whole-VM app, VM manager with the r13 image bound
# 2. site release r6 on the four edges (the dashboard row shows an address once the deployment is on version 4)
# 3. waits while the owner signs the three steps on the signing page, then finish.sh
# Every part skips what is already done; run it again after fixing whatever stopped it.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd); REPO=$(cd "$HERE/../../.." && pwd)
RELEASE=/vm/enclave-volumes/rpc-snp-release-r13
SITE=${SITE_R6:-$REPO/../unified-funding-20261028/whole-vm-address-site-r6}
PAGE=http://127.0.0.1:42291

bash "$HERE/host-prepare.sh" all "$RELEASE/agent" "$REPO"

if [ -f "$SITE/run-activate.py" ]; then
  (cd "$SITE" && python3 run-activate.py) || echo "site release r6 is not active on every edge; see $SITE/*.result.txt (the rest does not depend on it)"
else echo "no site release r6 working copy at $SITE; skipped"; fi

if ! curl -s -m 5 -o /dev/null "$PAGE/plan"; then
  systemd-run --user --unit=enclave-rpc-owner-sign-r13 --collect -p WorkingDirectory="$REPO" /usr/bin/node rpc/snp/owner-sign/server.mjs "$RELEASE/PLAN.json" 42291
  sleep 3
fi
echo
echo "Now sign the three steps at $PAGE (publish, stop, then start once the page offers it)."
echo "This terminal follows along and finishes the move after the start transaction."
echo
bash "$HERE/finish.sh" "$PAGE/status" "$RELEASE/cvm.sh"
