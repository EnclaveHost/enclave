#!/bin/bash
# The locked offline production build from the COMMITTED head: both tracked generated files must come out byte-identical
# (clean tree), the dashboard graph still carries the wallet route, and dist differs from the reviewed ae00cd965 dist only
# where the footer stamp (commit) does.
set -euo pipefail
W="$(cd "$(dirname "$0")/.." && pwd)"
cd "$W/repo"; H=$(git rev-parse HEAD); echo "source HEAD $H tree $(git rev-parse HEAD^{tree})"; test -z "$(git status --porcelain --untracked-files=no)"
rm -rf "$W/verify-tree"; git worktree prune; git worktree add -q --detach "$W/verify-tree" "$H"; cp -a node_modules "$W/verify-tree/node_modules"
cd "$W/verify-tree"
export TMPDIR="$W/tmp" npm_config_cache="$W/tmp/npm-cache" npm_config_offline=true npm_config_update_notifier=false
timeout -k 10 1200 unshare -r -n node scripts/build-site.mjs > "$W/logs/verify-build.log" 2>&1 || { tail -30 "$W/logs/verify-build.log"; exit 1; }
grep -E "^\[build\] (dist|csp)" "$W/logs/verify-build.log"
rc=0
echo "== tracked files after the build (must be none)"; s=$(git status --porcelain --untracked-files=no); echo "${s:-(clean)}"; [ -z "$s" ] || rc=1
sha256sum site/js/gen/contract-artifacts.js site/css/site.css contracts/EnclaveRegistry.abi.json contracts/EnclaveProofOfTime.abi.json
D=site/dist
(cd "$D" && find . -type f | LC_ALL=C sort | xargs sha256sum) > "$W/logs/dist-manifest.sha256"
echo "dist files $(wc -l < "$W/logs/dist-manifest.sha256")  manifest sha256 $(sha256sum < "$W/logs/dist-manifest.sha256" | cut -d' ' -f1)"
ls "$D"/js/chunks | grep -E '^profile-broadcast-.*\.js$' || { echo "NO profile-broadcast chunk"; rc=1; }
grep -o '<span data-build>[^<]*</span>' "$D/dashboard.html" | head -1
echo "pre-rewrite literal in dist: $(grep -rli "tin""foil" "$D" | wc -l)"
echo "== against the reviewed ae00cd965 dist"
P="$W/../rpc-wallet-production-build-20261023/build-tree/site/dist"
python3 - "$W/../rpc-wallet-production-build-20261023/logs/dist-manifest.sha256" "$W/logs/dist-manifest.sha256" "$P" "$D" "$(git rev-parse --short=8 HEAD)" <<'PY' || rc=1
import sys, os
old = dict(l.split()[::-1] for l in open(sys.argv[1])); new = dict(l.split()[::-1] for l in open(sys.argv[2]))
P, D, short = sys.argv[3], sys.argv[4], sys.argv[5]
print("files only in old:", sorted(set(old) - set(new)), "| only in new:", sorted(set(new) - set(old)))
changed = sorted(f for f in old if f in new and old[f] != new[f])
print("changed:", len(changed))
ok = set(old) == set(new)
for f in changed:
    a = open(os.path.join(P, f), encoding="utf8").read(); b = open(os.path.join(D, f), encoding="utf8").read()
    # the only allowed difference: the footer stamp's commit (ae00cd96 -> this head); the date is the build date
    same = a.replace("ae00cd96 · ", short + " · ") == b
    print(("  stamp-only " if same else "  OTHER      ") + f)
    ok = ok and same
print("PASS dist differs only in the footer commit stamp" if ok else "FAIL dist differs beyond the footer stamp")
sys.exit(0 if ok else 1)
PY
echo "verify rc=$rc"; exit $rc
