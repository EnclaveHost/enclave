#!/bin/bash
# Read-only follow-up: reth NAT/network/storage sources pinned BY COMMIT SHA. 20 s / 8 MiB each, no retries.
set -u
RT=05ba48120a0ce8d6beb65f0b2a7ad4710f4f2915   # paradigmxyz/reth v2.8.0
cd "$(dirname "$0")/../evidence/sources" || exit 2
get() { mkdir -p "$(dirname "$1")"; curl -sS -L --proto =https --max-time 20 --max-filesize 8388608 -A enclave-l1-source-audit -o "$1" -w "%{http_code} %{size_download} $2\n" "$2" >> fetch.log 2>&1 || echo "FAIL $2" >> fetch.log; }
for f in crates/net/nat/src/lib.rs crates/node/core/src/args/network.rs docs/vocs/docs/pages/run/storage.mdx docs/vocs/docs/pages/run/storage/index.mdx; do
  get "reth-v2.8.0/$f" "https://raw.githubusercontent.com/paradigmxyz/reth/$RT/$f"; done
find . -type f ! -name SHA256SUMS ! -name fetch.log -print0 | sort -z | xargs -0 sha256sum > SHA256SUMS; tail -4 fetch.log
