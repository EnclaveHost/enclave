#!/bin/bash
# Bounded read-only fetch of PRIMARY OP Stack source (GitHub raw, ethereum-optimism/optimism) for the L1 deposit rules
# (sender aliasing, gas floor, data bound, pause). At most 8 GETs, 20 s each, 2 MiB each. No RPC, no credentials.
set -u
D=$(cd "$(dirname "$0")/.." && pwd)/evidence/op-source
B=https://raw.githubusercontent.com/ethereum-optimism/optimism
n=0
get() { n=$((n+1)); [ $n -le 8 ] || { echo "budget"; return; }
  out="$D/$(echo "$1@$2" | tr '/' '_')"; curl -sS -f -m 20 --max-filesize 2097152 -o "$out" "$B/$1/$2" && echo "OK $1 $2 $(sha256sum "$out" | cut -c1-64) $(wc -c < "$out")" || { echo "FAIL $1 $2"; rm -f "$out"; }; }
for ref in develop; do
  get $ref packages/contracts-bedrock/src/L1/OptimismPortal2.sol
  get $ref packages/contracts-bedrock/src/libraries/EOA.sol
  get $ref packages/contracts-bedrock/src/vendor/AddressAliasHelper.sol
  get $ref packages/contracts-bedrock/src/L1/ResourceMetering.sol
done
date -u +%FT%TZ
