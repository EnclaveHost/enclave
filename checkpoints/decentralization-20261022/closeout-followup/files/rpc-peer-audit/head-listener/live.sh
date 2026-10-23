#!/bin/bash
# Bounded live run (root-authorized 2026-10-23): <=120 s (second probe; first was 60 s), <=20 peers, <=200 total dials, <=64 MiB output,
# published consensus bootnodes first, bounded discv5 only if no peer after 10 s.
# Loopback gossip listener, ephemeral in-memory key, isolated empty HOME.
set -uo pipefail
cd "$(dirname "$0")"
RUN="runs/live-$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$RUN/home"
BIN=target/debug/enclave-base-head-listener
echo "run=$RUN binary_sha256=$(sha256sum $BIN | cut -c1-64) start=$(date -u +%FT%TZ)"
HOME="$PWD/$RUN/home" RUST_LOG="warn,gossip=info,discovery=info" timeout -k 5 135 "$BIN" listen \
  --signer 0xAf6E19BE0F9cE7f8afd49a1824851023A8249e8a \
  --duration-secs 120 --max-peers 20 --max-output-bytes 67108864 \
  --out-dir "$RUN/out" --listen 127.0.0.1:0 \
  --discovery bounded --discovery-after-secs 10 \
  > "$RUN/heads.jsonl" 2> >(head -c 8388608 > "$RUN/stderr.log")
rc=$?
sleep 1
echo "listener rc=$rc end=$(date -u +%FT%TZ)"
echo "home entries after run: $(find "$RUN/home" -mindepth 1 | wc -l)"
echo "objects: $(ls "$RUN/out/objects" | wc -l) bytes: $(du -sb "$RUN/out" | cut -f1) stderr_bytes: $(wc -c < "$RUN/stderr.log")"
echo "$RUN" > runs/live.last
exit $rc
