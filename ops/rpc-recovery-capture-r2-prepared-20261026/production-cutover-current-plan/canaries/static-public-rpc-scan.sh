#!/usr/bin/env bash
# READ-ONLY static canary for shipped browser/CLI/guest artifacts (site build output, credit bundle, MCP/platform-api guest
# bundles, a release directory): in an own-rpc / verifier release NO public provider host may appear. Exit 0 clean, 1 found.
#   static-public-rpc-scan.sh <dir-or-file>...
set -uo pipefail
[ $# -ge 1 ] || { sed -n 2,4p "$0"; exit 2; }
RX='base-rpc\.publicnode\.com|base\.drpc\.org|mainnet\.base\.org|base-mainnet\.public\.blastapi\.io|1rpc\.io|base\.gateway\.tenderly\.co|base-public\.nodies\.app'
hits=$(grep -rEIl "$RX" "$@" 2>/dev/null | grep -v '\.map$' || true)
[ -z "$hits" ] && { echo "## clean: no public provider host in $*"; exit 0; }
echo "$hits" | while read -r f; do echo "FOUND $f: $(grep -oE "$RX" "$f" | sort -u | tr '\n' ' ')"; done; exit 1
