#!/bin/bash
# (1) the locked offline production build (scripts/build-site.mjs, unchanged) in a clean worktree of the reviewed head,
# (2) bytecode provenance + CSS checks of what it regenerated, (3) the two generated files saved to outputs/generated/.
set -euo pipefail
W="$(cd "$(dirname "$0")/.." && pwd)"
cd "$W/repo"; H=$(git rev-parse HEAD); echo "source HEAD $H tree $(git rev-parse HEAD^{tree})"; test -z "$(git status --porcelain --untracked-files=no)"
rm -rf "$W/gen-tree"; git worktree prune; git worktree add -q --detach "$W/gen-tree" "$H"; cp -a node_modules "$W/gen-tree/node_modules"
cd "$W/gen-tree"
sha256sum package-lock.json scripts/build-site.mjs scripts/build-contract-artifacts.mjs
for p in esbuild @tailwindcss/cli solc viem; do printf '%s %s\n' "$p" "$(node -p "require('./node_modules/$p/package.json').version")"; done
export TMPDIR="$W/tmp" npm_config_cache="$W/tmp/npm-cache" npm_config_offline=true npm_config_update_notifier=false
timeout -k 10 1200 unshare -r -n node scripts/build-site.mjs > "$W/logs/gen-build.log" 2>&1 || { tail -30 "$W/logs/gen-build.log"; exit 1; }
grep -E "^\[build\] (dist|csp)|artifacts\]" "$W/logs/gen-build.log"
echo "== tracked files the build rewrote"; git status --short --untracked-files=no
rc=0
echo "== bytecode provenance"
git -C "$W/repo" show HEAD:site/js/gen/contract-artifacts.js > "$W/tmp/committed-contract-artifacts.js"
node "$W/jobs/bytecode-provenance.mjs" "$W/repo" "$W/tmp/old-src" "$W/tmp/committed-contract-artifacts.js" site/js/gen/contract-artifacts.js || rc=1
echo "== css"
python3 "$W/jobs/css-check.py" <(git -C "$W/repo" show HEAD:site/css/site.css) site/css/site.css || rc=1
mkdir -p "$W/outputs/generated"; cp site/js/gen/contract-artifacts.js site/css/site.css "$W/outputs/generated/"
echo "== generated files (this build | previous ae00 build-tree)"
P="$W/../rpc-wallet-production-build-20261023/build-tree"
for f in site/js/gen/contract-artifacts.js site/css/site.css; do echo "$f $(sha256sum < $f | cut -c1-64) | $(sha256sum < $P/$f | cut -c1-64)"; done
echo "gen rc=$rc"; exit $rc
