#!/bin/bash
# One reading of the Enclave RPC guest's own memory report and health, kept for sizing a smaller guest.
#
#   reading.sh DIR      writes DIR/memory-<UTC>.json and DIR/health-<UTC>.json; python3 -I rpc/snp/memtrend.py DIR reads them
#
# Both are GETs on the guest's local name through the host's forward of its port; nothing in the guest changes.
set -euo pipefail
DIR=${1:?directory}; T=$(date -u +%Y%m%dT%H%M%SZ)
for what in memory health; do
  curl -sk -m 20 --resolve enclave-rpc:18443:127.0.0.1 "https://enclave-rpc:18443/$what" > "$DIR/.$what.new"
  python3 -I -c 'import json,sys; json.load(open(sys.argv[1]))' "$DIR/.$what.new"
  mv "$DIR/.$what.new" "$DIR/$what-$T.json"
done
