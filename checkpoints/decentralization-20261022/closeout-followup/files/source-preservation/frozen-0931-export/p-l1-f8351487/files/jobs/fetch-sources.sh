#!/bin/bash
# Read-only: fetch selected source/doc files pinned BY COMMIT SHA (raw.githubusercontent). 20 s / 8 MiB each, no retries.
set -u
LH=a376defa30470923556d91bdeb15a802e297f31f   # sigp/lighthouse v8.3.2
RT=05ba48120a0ce8d6beb65f0b2a7ad4710f4f2915   # paradigmxyz/reth v2.8.0
O=$(dirname "$0")/../evidence/sources; mkdir -p "$O/lighthouse-v8.3.2" "$O/reth-v2.8.0"; cd "$O" || exit 2
get() { mkdir -p "$(dirname "$1")"; curl -sS -L --proto =https --max-time 20 --max-filesize 8388608 -A enclave-l1-source-audit -o "$1" -w "%{http_code} %{size_download} $2\n" "$2" >> fetch.log 2>&1 || echo "FAIL $2" >> fetch.log; }
for f in beacon_node/src/cli.rs beacon_node/src/config.rs beacon_node/http_api/src/lib.rs beacon_node/http_api/src/block_id.rs \
  book/src/help_bn.md book/src/advanced_checkpoint_sync.md book/src/advanced_blobs.md book/src/installation.md book/src/advanced_database.md book/src/faq.md \
  common/eth2_network_config/built_in_network_configs/mainnet/config.yaml common/eth2_network_config/src/lib.rs; do
  get "lighthouse-v8.3.2/$f" "https://raw.githubusercontent.com/sigp/lighthouse/$LH/$f"; done
for f in crates/node/core/src/args/pruning.rs crates/prune/types/src/lib.rs crates/prune/types/src/mode.rs crates/prune/types/src/target.rs \
  crates/node/core/src/args/rpc_server.rs crates/node/core/src/args/engine.rs \
  docs/vocs/docs/pages/run/system-requirements.mdx docs/vocs/docs/pages/run/storage/pruning.mdx docs/vocs/docs/pages/run/ethereum.mdx; do
  get "reth-v2.8.0/$f" "https://raw.githubusercontent.com/paradigmxyz/reth/$RT/$f"; done
find . -type f ! -name SHA256SUMS ! -name fetch.log -print0 | sort -z | xargs -0 sha256sum > SHA256SUMS; cat fetch.log | awk '{print $1, $2}' | sort | uniq -c
