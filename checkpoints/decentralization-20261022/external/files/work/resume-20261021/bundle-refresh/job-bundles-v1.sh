#!/usr/bin/env bash
# ONE queued job (1024 MiB). Rebuild the reconciled candidate's two generated guest bundles with the repository's own
# scripts, in a SCRATCH copy (candidate + REAL copies of main's installed node_modules; Foundry out linked read-only),
# then the scripts' own --check, node --check, a reproducibility rebuild, manifest dependency equality vs the old
# manifests, and the existing end-to-end smoke of the actual MCP bundle. The candidate itself is NOT written here.
set -euo pipefail
W=/home/steven/Documents/Codex/2026-10-18/wo/work
C=$W/resume-20261021/reconciled-candidate; M=$W/enclave; H=$W/resume-20261021/bundle-refresh; S=$H/tree
export GIT_OPTIONAL_LOCKS=0 TMPDIR=$H/tmp
rm -rf "$S" "$H/out" "$H/out2" "$TMPDIR"; mkdir -p "$TMPDIR"
cp -a "$C" "$S"
for nm in node_modules relay/node_modules sdk/sessions/node_modules; do cp -a "$M/$nm" "$S/$nm"; done
[ -e "$S/contracts/foundry/out" ] || ln -s "$M/contracts/foundry/out" "$S/contracts/foundry/out"
cd "$S"
echo "== before: the candidate's committed bundles vs this tree"
for b in platform-api mcp; do s=scripts/build-$b-guest-bundle.mjs; if node "$s" --check > "$H/before-$b.out" 2>&1; then echo "$b: CURRENT"; else echo "$b: STALE ($(grep -o 'the .* stale[^;]*' "$H/before-$b.out" | head -1))"; fi; done
echo "== build"
node scripts/build-platform-api-guest-bundle.mjs --out "$H/out"
node scripts/build-mcp-guest-bundle.mjs --out "$H/out"
node scripts/build-platform-api-guest-bundle.mjs --out "$H/out2"
node scripts/build-mcp-guest-bundle.mjs --out "$H/out2"
cmp "$H/out/platform-api.bundle.mjs" "$H/out2/platform-api.bundle.mjs"; cmp "$H/out/mcp-server.bundle.mjs" "$H/out2/mcp-server.bundle.mjs"
cmp "$H/out/platform-api.bundle.mjs.manifest.json" "$H/out2/platform-api.bundle.mjs.manifest.json"; cmp "$H/out/mcp-server.bundle.mjs.manifest.json" "$H/out2/mcp-server.bundle.mjs.manifest.json"
echo "REPRODUCIBLE: two builds byte-identical (bundles + manifests)"
cp "$H/out/"*.bundle.mjs "$H/out/"*.manifest.json metal/guest/
node scripts/build-platform-api-guest-bundle.mjs --check
node scripts/build-mcp-guest-bundle.mjs --check
node --check metal/guest/platform-api.bundle.mjs; node --check metal/guest/mcp-server.bundle.mjs; echo "SYNTAX-OK both bundles"
python3 - "$C" "$S" <<'PY' > "$H/manifest-delta.json"
import json,sys
C,S=sys.argv[1:]
out={}
for b in ('platform-api','mcp-server'):
    o=json.load(open(f'{C}/metal/guest/{b}.bundle.mjs.manifest.json')); n=json.load(open(f'{S}/metal/guest/{b}.bundle.mjs.manifest.json'))
    keys=set(o['inputs'])|set(n['inputs'])
    nm=lambda k:'node_modules' in k
    d={'old':{'sha256':o['sha256'],'bytes':o['bytes'],'inputs':len(o['inputs'])},'new':{'sha256':n['sha256'],'bytes':n['bytes'],'inputs':len(n['inputs'])},
       'depChanged':sorted(k for k in keys if nm(k) and o['inputs'].get(k)!=n['inputs'].get(k)),
       'srcChanged':sorted(k for k in keys if not nm(k) and o['inputs'].get(k)!=n['inputs'].get(k)),
       'srcAdded':sorted(k for k in set(n['inputs'])-set(o['inputs']) if not nm(k)),'srcRemoved':sorted(k for k in set(o['inputs'])-set(n['inputs']) if not nm(k)),
       'sidecars':{'old':o.get('sidecars'),'new':n.get('sidecars')}}
    out[b]=d
print(json.dumps(out,indent=1))
PY
python3 -c "
import json;d=json.load(open('$H/manifest-delta.json'))
for b,v in d.items(): print(b,'deps changed:',len(v['depChanged']),'src changed:',v['srcChanged'],'added:',v['srcAdded'],'removed:',v['srcRemoved'])
bad=[b for b,v in d.items() if v['depChanged']]
assert not bad, f'dependency inputs differ from the old manifests: {bad}'
print('DEPENDENCIES-EQUAL-OLD-MANIFESTS')"
echo "== smoke: the existing end-to-end test of the ACTUAL mcp bundle (test/mcp-hosted-control.test.mjs)"
node --test --test-concurrency=1 --test-reporter=tap test/mcp-hosted-control.test.mjs > "$H/smoke-mcp.out" 2>&1 || { tail -60 "$H/smoke-mcp.out"; echo "SMOKE-FAILED"; exit 1; }
grep -E "^# (tests|pass|fail|skipped|cancelled|todo)" "$H/smoke-mcp.out"
grep -q "^# fail 0" "$H/smoke-mcp.out"; grep -q "^# skipped 0" "$H/smoke-mcp.out"; grep -q "^# cancelled 0" "$H/smoke-mcp.out"
echo "SMOKE-OK (no test skipped)"
sha256sum "$H/out/"*
echo BUNDLES-OK
