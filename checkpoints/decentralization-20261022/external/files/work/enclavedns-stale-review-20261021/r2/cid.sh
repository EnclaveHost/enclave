#!/usr/bin/env bash
# local, offline CID computation (no add, no network): new artifact and, as method control, v4's published bytes
R=/home/steven/Documents/Codex/2026-10-18/wo/work/enclavedns-stale-20261021/release-0.1.5-r2/enclavedns-0.1.5.wasm
V4=/home/steven/Documents/Codex/2026-10-18/wo/work/bootstrap-cas/bafybeicsvzar5llxdpwzypbhpo66sr5emywuum3u7jbvb35dnsz37h34uu.bin
for f in $R $V4; do echo "$(sha256sum $f | cut -c1-16) $(timeout 60 ipfs add --only-hash --cid-version=1 -Q --offline $f 2>&1)"; done
