#!/usr/bin/env bash
# Offline artifact checks: validate, interface vs v4, version string, and the lookup subcommand on names that never
# leave the process (localhost, special-use .invalid). No network listener is opened.
cd /home/steven/Documents/Codex/2026-10-18/wo/work/enclavedns-stale-20261021/release-0.1.5
wasm-tools validate --features all /home/steven/Documents/Codex/2026-10-18/wo/work/enclavedns-stale-20261021/release-0.1.5/target/wasm32-wasip2/release/enclavedns.wasm && echo "validate: ok"
diff <(wasm-tools component wit /home/steven/Documents/Codex/2026-10-18/wo/work/bootstrap-cas/bafybeicsvzar5llxdpwzypbhpo66sr5emywuum3u7jbvb35dnsz37h34uu.bin) <(wasm-tools component wit /home/steven/Documents/Codex/2026-10-18/wo/work/enclavedns-stale-20261021/release-0.1.5/target/wasm32-wasip2/release/enclavedns.wasm) > wit.diff && echo "component WIT identical to v4 (0d14ec08)" || { echo "WIT differs:"; head -40 wit.diff; }
strings -n 8 /home/steven/Documents/Codex/2026-10-18/wo/work/enclavedns-stale-20261021/release-0.1.5/target/wasm32-wasip2/release/enclavedns.wasm | grep -o -E 'EnclaveDNS ?0\.1\.[0-9]+|\] 0\.1\.[0-9]+ up' | sort -u
echo '{"recursion": true, "resolver": {"forward": ["udp://127.0.0.1:9"], "validate": false}, "listen": {}}' > smoke.json
t0=$(date +%s); timeout --foreground 60 wasmtime run -Scli -Stcp -Sudp -Sinherit-network -Sallow-ip-name-lookup --dir .::. --env ENCLAVEDNS_CONFIG=smoke.json /home/steven/Documents/Codex/2026-10-18/wo/work/enclavedns-stale-20261021/release-0.1.5/target/wasm32-wasip2/release/enclavedns.wasm lookup localhost A no-such.invalid A 2>&1 | head -12; echo "lookup exit=${PIPESTATUS[0]} after $(( $(date +%s)-t0 ))s"
