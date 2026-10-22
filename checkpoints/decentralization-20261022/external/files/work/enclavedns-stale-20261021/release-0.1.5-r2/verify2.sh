#!/usr/bin/env bash
cd /home/steven/Documents/Codex/2026-10-18/wo/work/enclavedns-stale-20261021/release-0.1.5-r2
t0=$(date +%s); timeout --foreground 60 wasmtime run -Scli -Stcp -Sudp -Sinherit-network -Sallow-ip-name-lookup --dir .::. --env ENCLAVEDNS_CONFIG=smoke.json /home/steven/Documents/Codex/2026-10-18/wo/work/enclavedns-stale-20261021/release-0.1.5-r2/enclavedns-0.1.5.wasm lookup localhost A no-such.invalid A 2>&1 | head -8; echo "lookup exit=${PIPESTATUS[0]} after $(( $(date +%s)-t0 ))s"
echo "== v4 on-chain config (read-only)"; timeout --foreground 30 node read-v4-config.mjs > v4-version.json && echo "v4 read ok $(sha256sum < v4-version.json | cut -c1-16)"
