#!/bin/bash
# which RPC-like hosts the built site/dist (from 349318a, job sb1) names, and the closure strings, outside and inside vendor/
set -uo pipefail
D="$(cd "$(dirname "$0")/.." && pwd)/bundle-349318a/site/dist"
echo "== page js (dist/js):"
grep -rhoE "https://[a-z0-9.-]*(base\.org|publicnode\.com|drpc\.org|1rpc\.io|tenderly\.co|polkachu\.com|alchemy|infura|ankr|llamarpc|walletconnect\.(org|com))[a-z0-9/._-]*" "$D/js" | sort | uniq -c
echo "== vendor (copied unchanged):"
grep -rhoE "https://[a-z0-9.-]*(base\.org|publicnode\.com|drpc\.org|1rpc\.io|tenderly\.co|polkachu\.com)[a-z0-9/._-]*" "$D/vendor" | sort | uniq -c
echo "== vendor bundles identical to the committed ones:"
for f in "$D"/vendor/*.js; do cmp -s "$f" "$D/../vendor/$(basename "$f")" && echo "same $(basename "$f")" || echo "DIFFERS $(basename "$f")"; done
echo "== js file digest list"; (cd "$D" && find js -type f -name '*.js' | sort | xargs sha256sum) | sha256sum
