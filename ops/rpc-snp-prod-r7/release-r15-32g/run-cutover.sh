#!/bin/bash
# The operator's one command for moving Enclave RPC from 1.4.2 to 1.4.3: the same image (r15) and measurement, with the
# guest at 32 GiB instead of 48. Measured on 1.4.2 with both chains at head: 11.6 GiB of anonymous memory in the guest
# and 30 GiB available of 46.
#
#   bash ops/rpc-snp-prod-r7/release-r15-32g/run-cutover.sh
#
# The VM manager already binds image r15, so nothing on the host is prepared. The owner signs the three steps on the
# signing page (publish, stop, start), then finish.sh follows the guest up. Ethereum and Base are down from the stop
# until the new guest's clients are back at head. Every part skips what is already done.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd); REPO=$(cd "$HERE/../../.." && pwd)
RELEASE=/vm/enclave-volumes/rpc-snp-release-r15-32g
# metal0's control VM moved since cvm.sh was written; its address there is stale
export CVM_IP=${CVM_IP:-172.25.202.35}
PAGE=http://127.0.0.1:42298

[ "$(python3 -I -c 'import json,sys;print(list(json.load(open(sys.argv[1]))["bindings"].values())[0]["image"])' "$HOME/.config/enclave/snpvm.json")" = /vm/enclave-volumes/rpc-snp-image-r15 ] || { echo "the VM manager does not bind image r15"; exit 1; }
if ! curl -s -m 5 -o /dev/null "$PAGE/plan"; then
  systemd-run --user --unit=enclave-rpc-owner-sign-r15-32g --collect -p WorkingDirectory="$REPO" /usr/bin/node rpc/snp/owner-sign/server.mjs "$RELEASE/PLAN.json" 42298
  sleep 3
fi
echo
echo "Now sign the three steps at $PAGE (publish, stop, then start once the page offers it)."
echo "This terminal follows along and finishes the move after the start transaction."
echo
bash "$HERE/finish.sh" "$PAGE/status" /vm/enclave-volumes/rpc-snp-release-r14/cvm.sh
