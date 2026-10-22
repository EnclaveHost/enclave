#!/usr/bin/env bash
# READ-ONLY: is the expected 0.1.5 artifact already pinned? (public gateway reads, no auth)
C=bafybeic3peeqxip4w2sxz66krxbhkjygfnkqyigdgvoajw6moykvtkfeau
W='  -> code=%{http_code} size=%{size_download} ip=%{remote_ip} ttfb=%{time_starttransfer} total=%{time_total}\n'
echo "== HEAD ipfs.enclave.host/ipfs/$C $(date -u +%TZ)"; curl -sS -I --max-time 30 -w "$W" https://ipfs.enclave.host/ipfs/$C | grep -i -E "^HTTP|content-length|etag|x-ipfs|->"
echo "== GET bytes sha256"; curl -sS --max-time 60 -o /tmp/enclavedns-0.1.5-readback.wasm -w "$W" https://ipfs.enclave.host/ipfs/$C; sha256sum /tmp/enclavedns-0.1.5-readback.wasm 2>/dev/null; rm -f /tmp/enclavedns-0.1.5-readback.wasm
echo "== status files"; curl -sS --max-time 25 https://ipfs.enclave.host/api/status | head -c 400; echo
