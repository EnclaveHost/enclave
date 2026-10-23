#!/bin/bash
# Read-only primary-source fetch (GitHub API/raw + docs.base.org). Bounded: each request 20 s, 8 MiB max, no retries.
set -u
O=$(dirname "$0")/../evidence/upstream-$(date -u +%Y%m%dT%H%M%SZ); mkdir -p "$O"; cd "$O" || exit 2
get() { curl -sS -L --proto =https --max-time 20 --max-filesize 8388608 -A fresh-witness-audit -o "$1" -w "%{http_code} %{size_download} $2\n" "$2" >> fetch.log 2>&1 || echo "FAIL $2" >> fetch.log; }
get base-main-commit.json https://api.github.com/repos/base/base/commits/main
get base-releases.json "https://api.github.com/repos/base/base/releases?per_page=3"
SHA=$(python3 -c "import json;print(json.load(open('base-main-commit.json'))['sha'])" 2>/dev/null)
echo "base main $SHA" >> fetch.log
get base-Cargo.lock https://raw.githubusercontent.com/base/base/$SHA/Cargo.lock
get base-node.rs https://raw.githubusercontent.com/base/base/$SHA/crates/execution/node/src/node.rs
REV=$(grep -oE 'git\+https://github.com/base/reth\?[^#]*#[0-9a-f]{40}' base-Cargo.lock | head -1 | sed 's/.*#//')
echo "base/reth rev $REV" >> fetch.log
get basereth-net-config.rs https://raw.githubusercontent.com/base/reth/$REV/crates/net/network/src/config.rs
get basereth-args-network.rs https://raw.githubusercontent.com/base/reth/$REV/crates/node/core/src/args/network.rs
get reth-main-commit.json https://api.github.com/repos/paradigmxyz/reth/commits/main
RSHA=$(python3 -c "import json;print(json.load(open('reth-main-commit.json'))['sha'])" 2>/dev/null)
echo "reth main $RSHA" >> fetch.log
get reth-args-network.rs https://raw.githubusercontent.com/paradigmxyz/reth/$RSHA/crates/node/core/src/args/network.rs
get reth-net-config.rs https://raw.githubusercontent.com/paradigmxyz/reth/$RSHA/crates/net/network/src/config.rs
get base-docs-llms.txt https://docs.base.org/llms.txt
sha256sum * > SHA256SUMS
cat fetch.log
