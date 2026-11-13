#!/bin/bash
# The operator's one command for moving Enclave RPC from 1.4.0 to 1.4.1: the same image (r14) in a 48 GiB guest
# instead of a 64 GiB one.
#
#   bash ops/rpc-snp-prod-r7/release-r14-48g/run-cutover.sh
#
# Nothing on the host is changed for this version before the owner signs: the image, its measurement, the VM
# manager's binding and the local proxy stay r14's, and the guest's size comes from the catalog version. So this
# 1. shows what the running guest holds now against what 48 GiB would give it (the owner signs on that, see README)
# 2. makes sure the owner's signing page is up (publish version 6, stop, start)
# 3. follows along and, after the start, runs finish.sh (gateway policy to version 6, route record, app address)
# Enclave RPC is down from the stop until the new guest's clients are back at head. Every part skips what is already
# done; run it again after fixing whatever stopped it.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd); REPO=$(cd "$HERE/../../.." && pwd)
RELEASE=/vm/enclave-volumes/rpc-snp-release-r14-48g
PAGE=http://127.0.0.1:42295

mkdir -p "$RELEASE/readings"
if bash "$HERE/reading.sh" "$RELEASE/readings" 2>/dev/null; then
  python3 -I "$REPO/rpc/snp/memtrend.py" "$RELEASE/readings" | { read -r head; echo "$head"; tail -n 7; }
  echo "A 48 GiB guest gives the clients' slice about 41.6 GiB (90% of about 46.3). Less the anonymous memory"
  echo "('anon all'), that is the page cache the three clients would share; today's is under 'file all'."
else
  echo "no memory report from the running guest (it is not version 5 at 64 GiB, or it is down)"
fi

if ! curl -s -m 5 -o /dev/null "$PAGE/plan"; then
  systemd-run --user --unit=enclave-rpc-owner-sign-r14-48g --collect -p WorkingDirectory="$REPO" /usr/bin/node rpc/snp/owner-sign/server.mjs "$RELEASE/PLAN.json" 42295
  sleep 3
fi
echo
echo "Now sign the three steps at $PAGE (publish, stop, then start once the page offers it)."
echo "This terminal follows along and finishes the move after the start transaction."
echo
bash "$HERE/finish.sh" "$PAGE/status" /vm/enclave-volumes/rpc-snp-release-r14/cvm.sh
