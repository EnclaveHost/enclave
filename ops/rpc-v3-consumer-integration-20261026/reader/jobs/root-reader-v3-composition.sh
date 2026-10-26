#!/bin/bash
# reader-runtime-composition-stage/r2: ROOT offline qualification of KVM reader v3 (34a3c0d6d) composed onto the v2 tree 1df12559 (PREPARED,
# NOT run by Claude). Shared queue, no network:
#   cd /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025 && ./jobs/q-exit-status.sh reader-v3-composition-1 768 unshare -Urn bash reader-runtime-composition-stage/r2/jobs/root-reader-v3-composition.sh
# Proves from the read-only source objects (never the stage's own claims): r2 tree 9dd20e76 = base 64156dcd + exactly the 32 listed 34a3c0d6d
# blobs = the rebuilt v2 tree 1df12559 + exactly the 12 c66->34a3 deltas; composition.patch on a clean base export and v2-to-r2.patch on a
# clean v2 export both reproduce it; no pre-existing file imports the reader (defaults unchanged); module closure; the v3 native/helios pins
# agree across config.v3.example.json, native.mjs and qualification.json; then KVM's 33 tests (provider 8 + boundaries 8 + coverage 13 +
# bridge 4) on the composed export, exact count, no skip/todo/cancel. node_modules are the candidate checkout's (64156dcd, lock 9ada1611),
# LINKED read-only. No native binary, no network, no config or production path is used.
set -uo pipefail; export PATH=/usr/bin:/bin
P=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025; V2S=$P/reader-runtime-composition-stage; ST=$V2S/r2
SRC=/home/steven/Projects/enclave; CT=$P/rpc-final-candidate-20261026/tree
BASE=64156dcd91ff1e769e74f9c26a846be19254c716; C66=c66b087acca2bed00e0232f97f990a201852faea; V3=34a3c0d6d4c5aebffffb2492437487c9de74fb66
V2TREE=1df125598825fb5278fe6af96a50a69b46679a1c; TREE=9dd20e7615ca16f69417309664f95db96640399f; V2SUMS=902786cd2709c1b41716d9cac71b861a016bba06464dfba4dadae26b53da8853
LOCK=9ada1611f431d9cc804af46bea54a5aca9e92b44bee40000ee7e995e25d69f20; NATIVE3=49f4d7e3e70e48f7374b0e12b3d300978062cce19cbd75552065f918173a76fa
HELIOS=cc962e2b97d545930a3c2051aa6e1c5b08a6c43a4b6b8021eead462ac02c07f0
OUT=$ST/logs/run-$(date -u +%Y%m%dT%H%M%SZ)-$$; rc=0
die() { echo "## SETUP: $*"; echo "## reader-v3-composition rc=9"; exit 9; }
fail() { echo "## FAIL: $*"; rc=1; }
ip link set lo up 2>/dev/null; ip -o route 2>/dev/null | grep -v ' lo ' | grep -q . && die "network route present: run under unshare -n"
(cd $ST && sha256sum -c --quiet SHA256SUMS) || die "r2 stage != its SHA256SUMS"
[ "$(sha256sum < $V2S/SHA256SUMS | cut -c1-64)" = $V2SUMS ] && (cd $V2S && sha256sum -c --quiet SHA256SUMS) || die "v2 stage is not the qualified 902786cd"
mkdir -p $OUT/tmp && G=$OUT/git && git init -q --bare $G && echo "$(cd $SRC && git --no-optional-locks rev-parse --path-format=absolute --git-common-dir)/objects" > $G/objects/info/alternates || die "private git"
GIT=(git --git-dir=$G)
[ "$("${GIT[@]}" rev-parse $V3^{commit})" = $V3 ] && [ "$("${GIT[@]}" rev-parse $V3^)" = $C66 ] && "${GIT[@]}" merge-base --is-ancestor $BASE $V3 || die "34a3c0d6d is not the c66b087 child descending from 64156dcd"
# ---- 1 reproduce the r2 tree two ways from the read-only objects ----
/usr/bin/python3 -I - $ST/COMPOSITION.json $V2S/COMPOSITION.json $G $BASE $C66 $V3 $V2TREE $TREE <<'PYT' || die "r2 tree does not reproduce"
import json, os, subprocess, sys
doc, v2, G, BASE, C66, V3, V2TREE, TREE = json.load(open(sys.argv[1])), json.load(open(sys.argv[2])), *sys.argv[3:]
g = lambda *a, env=None: subprocess.run(['git', f'--git-dir={G}', *a], capture_output=True, text=True, check=True, env=env).stdout.strip()
assert doc['base']['commit'] == BASE and doc['readerCommit'] == V3 and doc['readerParent'] == C66 and doc['composedTree'] == TREE and len(doc['files']) == 32
assert v2['composedTree'] == V2TREE and doc['v2Stage']['composedTree'] == V2TREE
delta = {l.split('\t')[1]: l.split('\t')[0] for l in g('diff', '--name-status', '--no-renames', C66, V3).splitlines()}
assert {d['path']: d['status'] for d in doc['deltaFromV2']} == delta and len(delta) == 12, 'deltaFromV2 != c66..34a3'
assert all(p.startswith(('network/derived-reader/', 'test/derived-reader')) for p in delta), 'v3 touches files outside the reader'
assert {f['path'] for f in doc['files']} == {f['path'] for f in v2['files']} | set(delta), 'r2 files != v2 files + v3 delta'
def build(start, entries):
    env = dict(os.environ, GIT_INDEX_FILE=f'{G}/compose.index'); g('read-tree', start, env=env)
    for f in entries:
        g('update-index', '--add', '--cacheinfo', f'{f["mode"]},{f["blob"]},{f["path"]}', env=env)
    t = g('write-tree', env=env); os.unlink(f'{G}/compose.index'); return t
for f in doc['files']:
    assert g('rev-parse', f'{V3}:{f["path"]}') == f['blob'], f['path']
    assert subprocess.run(['git', f'--git-dir={G}', 'cat-file', '-e', f'{BASE}:{f["path"]}'], capture_output=True).returncode != 0, f'{f["path"]} in base'
for p in doc['reusedFromBaseUnchanged']:
    assert g('rev-parse', f'{BASE}:{p}') == g('rev-parse', f'{V3}:{p}'), f'{p}: base blob != v3 blob'
assert build(BASE, doc['files']) == TREE, 'base + 32 blobs != r2 tree'
assert build(BASE, v2['files']) == V2TREE, 'v2 tree does not rebuild'
v3by = {f['path']: f for f in doc['files']}
assert build(V2TREE, [v3by[p] for p in delta]) == TREE, 'v2 tree + 12 deltas != r2 tree'
print('r2 tree reproduced:', TREE, '= base', BASE[:12], '+ 32 v3 blobs = v2', V2TREE[:12], '+ 12 deltas')
PYT
# ---- 2 exports; both patches reproduce the r2 tree from clean exports ----
mkdir -p $OUT/base $OUT/v2 $OUT/tree && "${GIT[@]}" archive $BASE | tar -x -C $OUT/base && "${GIT[@]}" archive $V2TREE | tar -x -C $OUT/v2 && "${GIT[@]}" archive $TREE | tar -x -C $OUT/tree || die "export"
(cd $OUT/base && git apply --whitespace=nowarn $ST/composition.patch) && diff -r -q $OUT/base $OUT/tree > /dev/null && echo "composition.patch on a clean base export == r2 tree" || fail "composition.patch does not reproduce the r2 tree"
(cd $OUT/v2 && git apply --whitespace=nowarn $ST/v2-to-r2.patch) && diff -r -q $OUT/v2 $OUT/tree > /dev/null && echo "v2-to-r2.patch on a clean v2 export == r2 tree" || fail "v2-to-r2.patch does not reproduce the r2 tree"
rm -rf $OUT/base $OUT/v2
# ---- 3 production defaults: nothing outside the composed set references the reader ----
/usr/bin/python3 -I - $OUT/tree $ST/COMPOSITION.json <<'PYD' || fail "a pre-existing module imports the new code (defaults would change)"
import json, pathlib, re, sys
T, doc = pathlib.Path(sys.argv[1]), json.load(open(sys.argv[2])); new = {f['path'] for f in doc['files']}
pat = re.compile(r'derived-reader/|lifecycle-finality-bridge|deployment-lifecycle-journal|deployment-restart-policy|coverage-store\.mjs')
hits = [p.relative_to(T).as_posix() for p in T.rglob('*') if p.is_file() and p.suffix in ('.mjs', '.js', '.cjs', '.json', '.sh', '.ts')
        and p.relative_to(T).as_posix() not in new and pat.search(p.read_text(errors='replace'))]
assert not hits, hits; print('no pre-existing file references the new modules')
PYD
# ---- 4 exact v3 pins agree: config.v3.example.json, native.mjs DERIVATION_V3_BUILDS, qualification.json, COMPOSITION pins ----
/usr/bin/python3 -I - $OUT/tree $ST/COMPOSITION.json $NATIVE3 $HELIOS <<'PYP' || fail "v3 pins disagree"
import json, pathlib, re, sys
T, doc, n3, hel = pathlib.Path(sys.argv[1]), json.load(open(sys.argv[2])), sys.argv[3], sys.argv[4]; R = T / 'network/derived-reader'
cfg, q = json.loads((R / 'config.v3.example.json').read_text()), json.loads((R / 'qualification.json').read_text())
nat = (R / 'native.mjs').read_text(); v3b = re.search(r'DERIVATION_V3_BUILDS = Object\.freeze\(\{(.*?)\}\)', nat, re.S).group(1)
assert cfg['native']['sha256'] == n3 and cfg['native']['resultVersion'] == 3 and cfg['l1']['binary']['sha256'] == hel
assert re.findall(r"'([0-9a-f]{64})'", v3b) == [n3], 'native.mjs DERIVATION_V3_BUILDS is not exactly the 49f4 build'
assert q['nativeV3']['sha256'] == n3 and q['composition'] == {'readerTests': 29, 'bridgeTests': 4, 'passed': 33, 'authorityFixtures': True, 'leaseCoverageTests': 13}
assert q['productionActivated'] is False and q['livePositiveBaseDerivation'] is False and q['acceptedImageQualified'] is False
assert q['nativeV3']['livePositiveBaseDerivation'] is False and q['nativeV3']['acceptedImageQualified'] is False
assert cfg['initializeState'] is False, 'example config must not initialize state'
p = doc['pins']; assert p['nativeV3Sha256'] == n3 and p['heliosSha256'] == hel
print('v3 pins agree: native', n3[:12], 'helios', hel[:12], '; qualification claims no activation/positive/accepted image')
PYP
# ---- 5 node_modules: the candidate checkout's, linked read-only after identity checks ----
[ "$(git -C $CT --no-optional-locks rev-parse HEAD)" = $BASE ] && [ -z "$(git -C $CT --no-optional-locks status --porcelain --untracked-files=no)" ] || die "candidate checkout is not a clean 64156dcd"
[ "$(sha256sum < $CT/package-lock.json | cut -c1-64)" = $LOCK ] && cmp -s $CT/package-lock.json $OUT/tree/package-lock.json || die "lock differs"
grep -q '"version": "2.53.1"' $CT/node_modules/viem/package.json || die "viem is not 2.53.1"
ln -s $CT/node_modules $OUT/tree/node_modules; [ -d $CT/network/node_modules ] && ln -s $CT/network/node_modules $OUT/tree/network/node_modules
echo "node_modules linked (read-only) from the candidate checkout; node $(node --version)"
# ---- 6 module closure over every composed .mjs ----
/usr/bin/python3 -I - $OUT/tree $ST/COMPOSITION.json <<'PYM' || fail "module closure"
import json, pathlib, re, sys
T, doc = pathlib.Path(sys.argv[1]), json.load(open(sys.argv[2])); bad, n = [], 0
imp = re.compile(r'''(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)|^\s*import\s*['"]([^'"]+)['"]''', re.M)
for f in doc['files']:
    if not f['path'].endswith('.mjs'):
        continue
    for m in imp.finditer((T / f['path']).read_text()):
        s = next(x for x in m.groups() if x); n += 1
        if s.startswith('.'):
            if not (T / f['path']).parent.joinpath(s).resolve().is_file(): bad.append((f['path'], s))
        elif not (s.startswith('node:') or s == 'viem'): bad.append((f['path'], s))
assert not bad, bad; print('module closure OK:', n, 'imports in', sum(1 for f in doc['files'] if f['path'].endswith('.mjs')), 'modules')
PYM
for f in $(/usr/bin/python3 -I -c 'import json,sys; [print(f["path"]) for f in json.load(open(sys.argv[1]))["files"] if f["path"].endswith(".mjs")]' $ST/COMPOSITION.json); do
  node --check $OUT/tree/$f 2>> $OUT/syntax.txt || fail "syntax $f"; done
(cd $OUT/tree && env -i PATH=/usr/bin:/bin HOME=$OUT/tmp TMPDIR=$OUT/tmp node --input-type=module -e "for (const m of ['./network/derived-reader/provider.mjs','./network/derived-reader/coverage.mjs','./network/derived-reader/coverage-store.mjs','./network/derived-reader/lifecycle.mjs','./network/derived-reader/api.mjs','./network/lifecycle-finality-bridge.mjs','./network/deployment-lifecycle-journal.mjs']) await import(m); console.log('imports load')" ) > $OUT/import.txt 2>&1 && echo "runtime import load OK (provider, coverage, coverage-store, lifecycle, api, bridge, journal)" || fail "runtime import (see $OUT/import.txt)"
# ---- 7 KVM's 33 tests on the composed export (exact total + per-suite top-level counts) ----
(cd $OUT/tree && env -i PATH=/usr/bin:/bin HOME=$OUT/tmp TMPDIR=$OUT/tmp timeout 1200 node --test --test-timeout=120000 --test-reporter=tap test/derived-reader.test.mjs test/lifecycle-finality-bridge.test.mjs < /dev/null) > $OUT/tests.tap 2>&1; r=$?
p=$(grep -E '^# pass ' $OUT/tests.tap | awk '{print $3}'); f=$(grep -E '^# fail ' $OUT/tests.tap | awk '{print $3}')
s=$(grep -E '^# (skipped|todo|cancelled) ' $OUT/tests.tap | awk '{s+=$3} END {print s+0}')
if [ $r = 0 ] && [ "$p" = 33 ] && [ "$f" = 0 ] && [ "$s" = 0 ]; then echo "PASS reader-v3-composition tests 33/33 (provider 8 + boundaries 8 + coverage 13 + bridge 4)"; else fail "tests: rc $r pass ${p:-?} fail ${f:-?} skip/todo/cancel $s (see $OUT/tests.tap)"; fi
for t in 'a real bridge callback can make both coverage queries without a reentrant reader lock' 'logs require exact snapshot identity and covered range; no old bootstrap, unknown filter or cancellation grants' \
         'full v3 runtime opens private coverage under its ownership and refuses missing history on restart'; do
  grep -qE "^\s*ok [0-9]+ - $(printf '%s' "$t" | sed 's/[][\.*^$(){}?+|/]/\\&/g')\s*$" $OUT/tests.tap && echo "passed by title: $t" || fail "required test not passed by title: $t"; done
"${GIT[@]}" count-objects > /dev/null; rm -rf $G/compose.index
(cd $ST && sha256sum -c --quiet SHA256SUMS) || fail "r2 stage CHANGED during the run"
(cd $V2S && sha256sum -c --quiet SHA256SUMS) || fail "v2 stage CHANGED during the run"
echo "## outputs: $OUT"; echo "## reader-v3-composition tree $TREE"; echo "## reader-v3-composition SHA256SUMS $(sha256sum < $ST/SHA256SUMS | cut -c1-64)"; echo "## reader-v3-composition rc=$rc"; exit $rc
