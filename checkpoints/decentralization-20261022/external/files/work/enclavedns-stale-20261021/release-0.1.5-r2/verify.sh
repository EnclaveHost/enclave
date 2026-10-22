#!/usr/bin/env bash
cd /home/steven/Documents/Codex/2026-10-18/wo/work/enclavedns-stale-20261021/release-0.1.5-r2
echo "== artifact"; ls -l /home/steven/Documents/Codex/2026-10-18/wo/work/enclavedns-stale-20261021/release-0.1.5-r2/enclavedns-0.1.5.wasm; sha256sum /home/steven/Documents/Codex/2026-10-18/wo/work/enclavedns-stale-20261021/release-0.1.5-r2/enclavedns-0.1.5.wasm
export IPFS_PATH=$(mktemp -d); ipfs init --profile test -e >/dev/null 2>&1
echo "== CID (kubo --only-hash, cid-version 1; method check on v4 first)"
for f in /home/steven/Documents/Codex/2026-10-18/wo/work/bootstrap-cas/bafybeicsvzar5llxdpwzypbhpo66sr5emywuum3u7jbvb35dnsz37h34uu.bin /home/steven/Documents/Codex/2026-10-18/wo/work/enclavedns-stale-20261021/release-0.1.5-r2/enclavedns-0.1.5.wasm; do echo "$(ipfs add --only-hash --offline -Q --cid-version=1 $f)  $(sha256sum < $f | cut -c1-64)"; done; rm -rf $IPFS_PATH
echo "== offline checks"
wasm-tools validate --features all /home/steven/Documents/Codex/2026-10-18/wo/work/enclavedns-stale-20261021/release-0.1.5-r2/enclavedns-0.1.5.wasm && echo "validate: ok"
diff <(wasm-tools component wit /home/steven/Documents/Codex/2026-10-18/wo/work/bootstrap-cas/bafybeicsvzar5llxdpwzypbhpo66sr5emywuum3u7jbvb35dnsz37h34uu.bin) <(wasm-tools component wit /home/steven/Documents/Codex/2026-10-18/wo/work/enclavedns-stale-20261021/release-0.1.5-r2/enclavedns-0.1.5.wasm) >/dev/null && echo "component WIT identical to v4 (0d14ec08)" || echo "WIT DIFFERS"
strings -n 8 /home/steven/Documents/Codex/2026-10-18/wo/work/enclavedns-stale-20261021/release-0.1.5-r2/enclavedns-0.1.5.wasm | grep -o -E 'EnclaveDNS ?0\.1\.[0-9]+|\] 0\.1\.[0-9]+ up' | sort -u | tr '\n' ' '; echo
echo '{"recursion": true, "resolver": {"forward": ["udp://127.0.0.1:9"], "validate": false}, "listen": {}}' > smoke.json
t0=$(date +%s); timeout --foreground 60 wasmtime run -Scli -Stcp -Sudp -Sinherit-network -Sallow-ip-name-lookup --dir .::. --env ENCLAVEDNS_CONFIG=smoke.json /home/steven/Documents/Codex/2026-10-18/wo/work/enclavedns-stale-20261021/release-0.1.5-r2/enclavedns-0.1.5.wasm lookup localhost A no-such.invalid A 2>&1 | head -8; echo "lookup exit=${PIPESTATUS[0]} after $(( $(date +%s)-t0 ))s"
echo "== v4 on-chain config (read-only)"; timeout --foreground 30 node read-v4-config.mjs > v4-version.json && echo "v4 read ok $(sha256sum < v4-version.json | cut -c1-16)"
