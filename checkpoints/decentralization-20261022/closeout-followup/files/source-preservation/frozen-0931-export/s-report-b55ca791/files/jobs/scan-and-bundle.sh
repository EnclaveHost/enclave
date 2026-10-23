#!/bin/bash
# (1) crypto-key scan of the commits added on e820e2405; (2) the production site bundle (scripts/build-site.mjs) built from
# the committed tree in its own worktree, then: the closure strings are in the bundle, and which RPC hosts the bundle names
set -euo pipefail
W="$(cd "$(dirname "$0")/.." && pwd)"
cd "$W/repo"
echo "== scan e820e2405..HEAD"; git log --oneline e820e2405..HEAD
python3 .githooks/scan-crypto-keys.py --range e820e2405..HEAD
echo "scan rc=$?"
cd "$W/bundle-349318a"
git log -1 --format='bundle tree HEAD %H'
timeout -k 10 900 node scripts/build-site.mjs
echo "== tracked files the build rewrote:"; git status --short | grep -v '^??' || echo "(none)"
D=site/dist
test -d "$D/js"
for s in "network profile changed in another tab" "broadcast by your wallet" "none of the network profile's RPC endpoints could check this transaction" \
  "Confirm a valid independent profile before connecting WalletConnect" "none of the network profile's RPC endpoints answered" "the profile's quorum" ; do
  n=$(grep -rlF -- "$s" "$D/js" "$D"/*.html 2>/dev/null | wc -l); echo "bundle files containing [$s]: $n"; done
echo "== RPC-like hosts named in the bundle js (outside vendor/):"
grep -rhoE "https://[a-z0-9.-]*(base\.org|publicnode\.com|drpc\.org|1rpc\.io|tenderly\.co|polkachu\.com|alchemy|infura|ankr|llamarpc)[a-z0-9/._-]*" "$D/js" | sort | uniq -c
echo "== dist file count / sha256 of the entry chunk list"; find "$D" -type f | wc -l; (cd "$D" && find js -type f -name '*.js' | sort | xargs sha256sum) | sha256sum
