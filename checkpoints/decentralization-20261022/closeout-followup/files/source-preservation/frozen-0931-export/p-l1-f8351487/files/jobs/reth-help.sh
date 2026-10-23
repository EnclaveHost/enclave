#!/bin/bash
# Offline (unshare -rn): the existing official reth v2.8.0 binary's own version and help. No datadir, no network.
set -u
cd "$(dirname "$0")/.." || exit 2
O=evidence/reth-help-$(date -u +%Y%m%dT%H%M%SZ); mkdir -p "$O"
sha256sum bin/reth-v2.8.0 > "$O/binary.sha256"
unshare -rn env -i PATH=/usr/bin:/bin HOME=/nonexistent bin/reth-v2.8.0 --version > "$O/version.txt" 2>&1; echo "version rc=$?" >> "$O/rc.txt"
unshare -rn env -i PATH=/usr/bin:/bin HOME=/nonexistent bin/reth-v2.8.0 node --help > "$O/node-help.txt" 2>&1; echo "node-help rc=$?" >> "$O/rc.txt"
(cd "$O" && sha256sum *.txt > SHA256SUMS); cat "$O/rc.txt" "$O/version.txt"; wc -l "$O/node-help.txt"
