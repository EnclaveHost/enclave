#!/bin/bash
# reader-runtime-composition-stage: ROOT offline qualification of the composed reader runtime (PREPARED). Shared queue, no network:
#   cd /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025 && ./jobs/q-exit-status.sh reader-composition-1 768 unshare -Urn bash reader-runtime-composition-stage/jobs/root-reader-composition.sh
# Proves from the read-only source objects (never the stage's own claims): the composed tree 1df12559 = base 64156dcd + exactly the 27 listed c66b087
# blobs; composition.patch applies to a clean base export and reproduces it; no pre-existing candidate module imports the new modules (production
# defaults unchanged); module closure (every relative import resolves inside the composed tree; bare specifiers are node: builtins or viem);
# then KVM's FINAL 20 tests (reader 16 + lifecycle bridge 4) on the composed export, exact count, no skip/todo/cancel. node_modules are the
# candidate checkout's (rpc-final-candidate-20261026/tree at 64156dcd, lock 9ada1611), LINKED read-only, never copied. No native binary is used.
set -uo pipefail; export PATH=/usr/bin:/bin
P=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025; ST=$P/reader-runtime-composition-stage; SRC=$P/source; CT=$P/rpc-final-candidate-20261026/tree
BASE=64156dcd91ff1e769e74f9c26a846be19254c716; C66=c66b087acca2bed00e0232f97f990a201852faea; TREE=1df125598825fb5278fe6af96a50a69b46679a1c; LOCK=9ada1611f431d9cc804af46bea54a5aca9e92b44bee40000ee7e995e25d69f20
OUT=$ST/logs/run-$(date -u +%Y%m%dT%H%M%SZ)-$$; rc=0
die() { echo "## SETUP: $*"; echo "## reader-composition rc=9"; exit 9; }
fail() { echo "## FAIL: $*"; rc=1; }
ip link set lo up 2>/dev/null; ip -o route 2>/dev/null | grep -v ' lo ' | grep -q . && die "network route present: run under unshare -n"
(cd $ST && sha256sum -c --quiet SHA256SUMS) || die "stage != its SHA256SUMS"
mkdir -p $OUT/tmp && G=$OUT/git && git init -q --bare $G && echo "$(cd $SRC && git rev-parse --path-format=absolute --git-common-dir)/objects" > $G/objects/info/alternates || die "private git"
GIT=(git --git-dir=$G)
[ "$("${GIT[@]}" rev-parse $C66^{commit})" = $C66 ] && "${GIT[@]}" merge-base --is-ancestor $BASE $C66 || die "c66b087 is not a descendant of the base 64156dcd"
# ---- 1 reproduce the composed tree from base + the listed blobs (each must be c66's blob at that path) ----
/usr/bin/python3 -I - $ST/COMPOSITION.json $G $BASE $C66 $TREE <<'PYT' || die "composed tree does not reproduce"
import json, os, subprocess, sys
doc, G, BASE, C66, TREE = json.load(open(sys.argv[1])), sys.argv[2], sys.argv[3], sys.argv[4], sys.argv[5]
g = lambda *a, env=None: subprocess.run(['git', f'--git-dir={G}', *a], capture_output=True, text=True, check=True, env=env).stdout.strip()
assert doc['base']['commit'] == BASE and doc['readerCommit'] == C66 and doc['composedTree'] == TREE and len(doc['files']) == 27
env = dict(os.environ, GIT_INDEX_FILE=f'{G}/compose.index'); g('read-tree', BASE, env=env)
for f in doc['files']:
    assert g('rev-parse', f'{C66}:{f["path"]}') == f['blob'], f['path']
    assert subprocess.run(['git', f'--git-dir={G}', 'cat-file', '-e', f'{BASE}:{f["path"]}'], capture_output=True).returncode != 0, f'{f["path"]} in base'
    g('update-index', '--add', '--cacheinfo', f'{f["mode"]},{f["blob"]},{f["path"]}', env=env)
t = g('write-tree', env=env); assert t == TREE, (t, TREE)
print('composed tree reproduced:', t, '= base', BASE[:12], '+', len(doc['files']), 'c66 blobs')
PYT
# ---- 2 exports; the patch reproduces the composed tree from a clean base export ----
mkdir -p $OUT/base $OUT/tree && "${GIT[@]}" archive $BASE | tar -x -C $OUT/base && "${GIT[@]}" archive $TREE | tar -x -C $OUT/tree || die "export"
cp -a $OUT/base $OUT/patched && (cd $OUT/patched && git apply --whitespace=nowarn $ST/composition.patch) && diff -r -q $OUT/patched $OUT/tree > /dev/null && echo "composition.patch on a clean base export == composed tree" || fail "patch does not reproduce the composed tree"
rm -rf $OUT/patched
# ---- 3 production defaults: nothing that existed before imports the new modules ----
/usr/bin/python3 -I - $OUT/tree $ST/COMPOSITION.json <<'PYD' || fail "a pre-existing module imports the new code (defaults would change)"
import json, pathlib, re, sys
T, doc = pathlib.Path(sys.argv[1]), json.load(open(sys.argv[2])); new = {f['path'] for f in doc['files']}
pat = re.compile(r'derived-reader/|lifecycle-finality-bridge|deployment-lifecycle-journal|deployment-restart-policy')
hits = [p.relative_to(T).as_posix() for p in T.rglob('*') if p.is_file() and p.suffix in ('.mjs', '.js', '.cjs', '.json', '.sh', '.ts')
        and p.relative_to(T).as_posix() not in new and pat.search(p.read_text(errors='replace'))]
assert not hits, hits; print('no pre-existing file references the new modules')
PYD
# ---- 4 node_modules: the candidate checkout's, linked read-only after identity checks ----
[ "$(git -C $CT --no-optional-locks rev-parse HEAD)" = $BASE ] && [ -z "$(git -C $CT --no-optional-locks status --porcelain --untracked-files=no)" ] || die "candidate checkout is not a clean 64156dcd"
[ "$(sha256sum < $CT/package-lock.json | cut -c1-64)" = $LOCK ] && cmp -s $CT/package-lock.json $OUT/tree/package-lock.json || die "lock differs"
grep -q '"version": "2.53.1"' $CT/node_modules/viem/package.json || die "viem is not 2.53.1"
ln -s $CT/node_modules $OUT/tree/node_modules; [ -d $CT/network/node_modules ] && ln -s $CT/network/node_modules $OUT/tree/network/node_modules
echo "node_modules linked (read-only) from the candidate checkout; node $(node --version)"
# ---- 5 module closure: every relative import of the new modules resolves in the composed tree; bare = node: or viem ----
/usr/bin/python3 -I - $OUT/tree $ST/COMPOSITION.json <<'PYM' || fail "module closure"
import json, pathlib, re, sys
T, doc = pathlib.Path(sys.argv[1]), json.load(open(sys.argv[2])); bad, n = [], 0
imp = re.compile(r'''(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)|^\s*import\s*['"]([^'"]+)['"]''', re.M)
for f in doc['files']:
    if not f['path'].endswith('.mjs'):
        continue
    src = (T / f['path']).read_text()
    for m in imp.finditer(src):
        s = next(x for x in m.groups() if x); n += 1
        if s.startswith('.'):
            if not (T / f['path']).parent.joinpath(s).resolve().is_file(): bad.append((f['path'], s))
        elif not (s.startswith('node:') or s == 'viem'): bad.append((f['path'], s))
assert not bad, bad; print('module closure OK:', n, 'imports in', sum(1 for f in doc['files'] if f['path'].endswith('.mjs')), 'modules')
PYM
for f in $(/usr/bin/python3 -I -c 'import json,sys; [print(f["path"]) for f in json.load(open(sys.argv[1]))["files"] if f["path"].endswith(".mjs")]' $ST/COMPOSITION.json); do
  node --check $OUT/tree/$f 2>> $OUT/syntax.txt || fail "syntax $f"; done
(cd $OUT/tree && env -i PATH=/usr/bin:/bin HOME=$OUT/tmp TMPDIR=$OUT/tmp node --input-type=module -e "for (const m of ['./network/derived-reader/provider.mjs','./network/derived-reader/lifecycle.mjs','./network/derived-reader/api.mjs','./network/lifecycle-finality-bridge.mjs','./network/deployment-lifecycle-journal.mjs']) await import(m); console.log('imports load')" ) > $OUT/import.txt 2>&1 && echo "runtime import load OK (provider, lifecycle, api, bridge, journal)" || fail "runtime import (see $OUT/import.txt)"
# ---- 6 KVM's final 20 tests on the composed export ----
(cd $OUT/tree && env -i PATH=/usr/bin:/bin HOME=$OUT/tmp TMPDIR=$OUT/tmp timeout 900 node --test --test-timeout=120000 --test-reporter=tap test/derived-reader.test.mjs test/lifecycle-finality-bridge.test.mjs < /dev/null) > $OUT/tests.tap 2>&1; r=$?
p=$(grep -E '^# pass ' $OUT/tests.tap | awk '{print $3}'); f=$(grep -E '^# fail ' $OUT/tests.tap | awk '{print $3}')
s=$(grep -E '^# (skipped|todo|cancelled) ' $OUT/tests.tap | awk '{s+=$3} END {print s+0}')
if [ $r = 0 ] && [ "$p" = 20 ] && [ "$f" = 0 ] && [ "$s" = 0 ]; then echo "PASS reader-composition tests 20/20 (reader 16 + bridge 4)"; else fail "tests: rc $r pass ${p:-?} fail ${f:-?} skip/todo/cancel $s (see $OUT/tests.tap)"; fi
rm -rf $OUT/base $G/compose.index
(cd $ST && sha256sum -c --quiet SHA256SUMS) || fail "stage CHANGED during the run"
echo "## outputs: $OUT"; echo "## reader-composition tree $TREE"; echo "## reader-composition SHA256SUMS $(sha256sum < $ST/SHA256SUMS | cut -c1-64)"; echo "## reader-composition rc=$rc"; exit $rc
