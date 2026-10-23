#!/bin/bash
# scripts/build-site.mjs, unchanged, in a clean detached worktree of HEAD (build-tree/), with NO network (unshare -r -n:
# nothing can be downloaded or uploaded) and npm's cache/logs inside this workspace. Records input and output hashes.
set -euo pipefail
W="$(cd "$(dirname "$0")/.." && pwd)"
cd "$W/repo"
H=$(git rev-parse HEAD); echo "source HEAD $H"; test -z "$(git status --porcelain --untracked-files=no)"
rm -rf "$W/build-tree"; git worktree prune
git worktree add -q --detach "$W/build-tree" "$H"
cp -a node_modules "$W/build-tree/node_modules"
cd "$W/build-tree"
echo "== inputs"
sha256sum package-lock.json scripts/build-site.mjs scripts/build-contract-artifacts.mjs scripts/site-built-in-profile.mjs
for p in esbuild @tailwindcss/cli tailwindcss solc viem; do printf '%s %s\n' "$p" "$(node -p "require('./node_modules/$p/package.json').version")"; done
echo "site/ tree: $(git rev-parse HEAD:site)  contracts/ tree: $(git rev-parse HEAD:contracts)"
export TMPDIR="$W/tmp" npm_config_cache="$W/tmp/npm-cache" npm_config_offline=true npm_config_update_notifier=false
echo "== build (no network)"
timeout -k 10 1200 unshare -r -n node scripts/build-site.mjs
echo "== tracked files the build rewrote"; git status --short --untracked-files=no
git diff --stat
echo "== outputs"
D=site/dist
find "$D" -type f | wc -l
(cd "$D" && find . -type f | LC_ALL=C sort | xargs sha256sum) > "$W/logs/dist-manifest.sha256"
echo "dist manifest sha256: $(sha256sum < "$W/logs/dist-manifest.sha256" | cut -d' ' -f1)"
ls "$D"/js/chunks | grep -E '^profile-broadcast-' || { echo "NO profile-broadcast chunk"; exit 1; }
for s in "eth_signTransaction" "every endpoint of the network profile refused" "does not sign a transaction without broadcasting" "Enclave runs part of this account" "the network profile (your wallet signs only)" "never relayed it"; do
  echo "dist js files containing [$s]: $(grep -rlF -- "$s" "$D/js" | wc -l)"; done
echo "pre-rewrite literal (tinfoil, any case) in dist: $(grep -rli tinfoil "$D" | wc -l)"
sha256sum "$D/csp-script-src.txt" "$D/dashboard.html" "$D/js/boot.js"
