#!/usr/bin/env bash
# Local CIDs only (--only-hash: nothing stored, nothing announced). Method validated on the v4 bytes first.
export IPFS_PATH=$(mktemp -d); ipfs init --profile test -e >/dev/null 2>&1
for f in /home/steven/Documents/Codex/2026-10-18/wo/work/bootstrap-cas/bafybeicsvzar5llxdpwzypbhpo66sr5emywuum3u7jbvb35dnsz37h34uu.bin /home/steven/Documents/Codex/2026-10-18/wo/work/enclavedns-stale-20261021/release-0.1.5/target/wasm32-wasip2/release/enclavedns.wasm; do echo "$(ipfs add --only-hash --offline -Q --cid-version=1 $f)  $(sha256sum < $f | cut -c1-64)  $f"; done
rm -rf $IPFS_PATH
