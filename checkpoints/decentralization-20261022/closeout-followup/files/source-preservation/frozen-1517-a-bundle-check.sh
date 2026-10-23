#!/bin/bash
# frozen-1517 ("1517" = batch start 2026-10-23T15:17Z, an identifier): validate the restore recipe of A-receipts' omitted compiled
# metal/guest/mcp-server.bundle.mjs at eab4cfac (the commit's own manifest pins every input). A throwaway clone of the exact commit
# carrying A-receipts' OWN node_modules LINKS (the build uses esbuild preserveSymlinks; frozen-1339 attempts 1-3 showed real copies or a
# missing nested root rebuild other bytes). The node_modules roots are taken from the manifest's input prefixes, not guessed. Then the
# repository's own `build-mcp-guest-bundle.mjs --check` (bundle bytes + manifest). Clone removed on every exit.
set -uo pipefail
A=/home/steven/Documents/Codex/2026-10-18/wo/work/resume-after-checkpoint-20261022/rpc-priority/repo-receipts
X=/home/steven/Documents/Codex/2026-10-18/wo/work/resume-after-checkpoint-20261022/rpc-priority-clone-1517
C=eab4cfac47a00dcbc0161918a2624eed6761bbfb
[ ! -e "$X" ] || { echo "$X exists"; exit 2; }
trap 'rm -rf "$X"' EXIT
export GIT_OPTIONAL_LOCKS=0
git clone -q --no-hardlinks --no-checkout "$A" "$X" && git -C "$X" -c advice.detachedHead=false checkout -q $C || exit 3
roots=$(git -C "$X" show $C:metal/guest/mcp-server.bundle.mjs.manifest.json | python3 -I -c "
import json,sys; m=json.load(sys.stdin); print(' '.join(sorted({p[:p.index('node_modules/')] or '.' for p in m['inputs'] if 'node_modules/' in p})))")
echo "node_modules roots from the manifest: $roots"
for d in $roots; do d=${d%/}; cp -a "$A/$d/node_modules" "$X/$d/node_modules"; echo "$d/node_modules -> $(readlink "$X/$d/node_modules") resolves: $(cd "$X/$d" && readlink -f node_modules)"; done
echo "committed bundle sha256 $(sha256sum < "$X/metal/guest/mcp-server.bundle.mjs" | cut -c1-64)"
(cd "$X" && node scripts/build-mcp-guest-bundle.mjs --check); rc=$?
echo "build-mcp-guest-bundle --check rc=$rc"
exit $rc
