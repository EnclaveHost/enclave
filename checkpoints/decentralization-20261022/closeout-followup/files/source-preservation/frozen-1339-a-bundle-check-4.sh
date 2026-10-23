#!/bin/bash
# frozen-1339 attempt 4: validate the restore recipe of A's omitted compiled metal/guest/mcp-server.bundle.mjs at 554a251c in A's OWN
# dependency layout. The build uses esbuild preserveSymlinks (inputs keep their in-tree paths) and A built through SYMLINKED
# node_modules: ./node_modules -> ../../native-front-abort/repo/node_modules (relative) and relay/node_modules (absolute link). A
# throwaway clone at the same depth under resume-after-checkpoint-20261022/ resolves both links to the same dependency trees.
# Attempt 1: links copied into a deeper clone -> dangling (esbuild missing). Attempt 2: REAL copies -> rebuilt bytes differ.
# Attempt 3: same depth, but sdk/sessions/node_modules (434 of the 2974 manifest inputs; an absolute link) was not carried.
# If --check fails, rebuild into a scratch dir (--out) and report which manifest inputs differ (read-only diagnosis).
set -uo pipefail
A=/home/steven/Documents/Codex/2026-10-18/wo/work/resume-after-checkpoint-20261022/rpc-priority/repo
X=/home/steven/Documents/Codex/2026-10-18/wo/work/resume-after-checkpoint-20261022/source-preservation/a-clone-1339
O=/home/steven/Documents/Codex/2026-10-18/wo/work/resume-after-checkpoint-20261022/source-preservation/frozen-1339-work/a-bundle-out
[ ! -e "$X" ] || { echo "$X exists"; exit 2; }
trap 'rm -rf "$X" "$O"' EXIT
export GIT_OPTIONAL_LOCKS=0
git clone -q --no-hardlinks --no-checkout "$A" "$X" && git -C "$X" -c advice.detachedHead=false checkout -q 554a251cbe14aa7ba8af4c160d9a8b9793e4071a || exit 3
for d in . relay sdk/sessions; do cp -a "$A/$d/node_modules" "$X/$d/node_modules"; echo "$d/node_modules -> $(readlink "$X/$d/node_modules") resolves: $(cd "$X/$d" && readlink -f node_modules)"; done
echo "committed bundle sha256 $(sha256sum < "$X/metal/guest/mcp-server.bundle.mjs" | cut -c1-64)"
(cd "$X" && node scripts/build-mcp-guest-bundle.mjs --check); rc=$?
echo "build-mcp-guest-bundle --check rc=$rc"
if [ $rc -ne 0 ]; then
  mkdir -p "$O"; (cd "$X" && node scripts/build-mcp-guest-bundle.mjs --out "$O") || echo "scratch build failed"
  python3 -I - "$X/metal/guest/mcp-server.bundle.mjs.manifest.json" "$O" <<'PY'
import json, sys, pathlib, hashlib
c = json.load(open(sys.argv[1])); o = pathlib.Path(sys.argv[2])
m = [p for p in o.rglob('*.manifest.json')]; b = [p for p in o.rglob('*.bundle.mjs')]
print('scratch outputs', [str(p.relative_to(o)) for p in m + b])
if m:
    n = json.load(open(m[0])); ci, ni = c['inputs'], n['inputs']
    diff = sorted(k for k in set(ci) | set(ni) if ci.get(k) != ni.get(k))
    print('inputs committed', len(ci), 'rebuilt', len(ni), 'differing', len(diff)); [print('  ', k, (ci.get(k) or '-')[:12], (ni.get(k) or '-')[:12]) for k in diff[:25]]
    print('bundle sha committed', c['sha256'][:16], 'rebuilt', n['sha256'][:16])
PY
fi
exit $rc
