#!/usr/bin/env bash
# r2 (rig-artifact-closure-stage/r2): the FROZEN original runner (../../jobs/root-r12-impacted-rerun.sh) with ONLY these corrections
#   (remaining-composition-triage findings): (a) offchain-heartbeat-writers' negative control gets the EXACT historical base
#   supervisor.js (6f2c7da46^:supervisor.js, blob 3ad76690...) as a file in the PRIVATE COPIED tree root, for that test only - production
#   source is never altered; the same 3/3, 0-skip requirement; (b) RESULTS rows are parsed by exact shape (component/REGRESS 5 fields,
#   STACK and NATIVE 3); NATIVE rows (F2, CHAIN_VERIFIER_INPUTS) are never artifact rows and keep their own verdict; an unknown shape is
#   HOLD; an adapted 'ok (...)' row is ok; (c) PATH holds exactly the pinned forge/anvil for the rigs' runtime builds. Selection is
#   unchanged otherwise: not-ok AND statically reaching the missing artifact AND its ENOENT in the actual receipt (finite closure).
# Root:  ./jobs/q-exit-status.sh r12-impacted-rerun-r2 2560 unshare -rn bash rig-artifact-closure-stage/r2/jobs/root-r12-impacted-rerun.sh
# rig-artifact-closure-stage: POST-RUN amendment of composition r12 for the ONE artifact its B2 subset missed (PREPARED; NOT run by
# Claude). Run only AFTER root-composition-r12-full-0313 has finished. r12 (stage, run dir, its trees, its receipts) is READ ONLY.
# Root, from work/rpc-production-final-20261025:
#   ./jobs/q-exit-status.sh r12-impacted-rerun 2560 unshare -rn bash rig-artifact-closure-stage/jobs/root-r12-impacted-rerun.sh
# 1. The r12-missing set is DERIVED: (map/needed-main-r12.txt) minus (every r12 tree's ARTIFACTS-<t>.sha256). It must equal
#    map/r12-missing.txt exactly (MockFeed from contracts/foundry/test/EnclaveDeployments.multicallValue.t.sol); anything else = HOLD.
# 2. Impacted rows = r12 RESULTS.tsv rows that are NOT ok AND whose test statically reaches a missing artifact (map/ARTIFACT-MAP.tsv)
#    AND whose actual r12 receipt shows ENOENT for it. Every other row keeps its r12 verdict + receipt (passed tests are NOT rerun).
# 3. Only the trees those rows need are copied (cp -a) out of r12 and checked identical (HEAD, porcelain incl. ignored, out/ manifest,
#    pinned source closure); the missing source is compiled OFFLINE by the pinned forge/solc in each copy; gates: every pre-existing
#    artifact keeps byte-identical bytecode/deployedBytecode objects, tracked files unchanged, MockFeed present, solc 0.8.35, target
#    exact, identical bytecode in every copy.
# 4. Only the (tree, test) pairs whose r12 receipt is not clean are rerun, with r12's exact command; each must report exactly the
#    r12 receipt's `# tests N`, N passing, 0 fail/cancelled/skipped/todo, rc 0. RESULTS-AMENDED.tsv carries EVERY r12 row.
# Exit: 0 every row ok and no other r12 [FAIL]; 3 impacted rows fixed but unrelated r12 failures remain (NOT a pass); 1 a rerun
# failed; 20 SETUP/HOLD (never a verdict).
set -uo pipefail
W=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025
ST=$W/rig-artifact-closure-stage; ST2=$ST/r2; R12=$W/rpc-runtime-composition-stage/r12; X=$R12/run/r4-20261026T031250Z; LOG=$W/logs/root-composition-r12-full-0313.out
setup() { echo "[FAIL] $1"; echo "RESULT: SETUP-FAILURE (not a test verdict)"; exit 20; }
ok() { echo "[ok] $1"; }
ip link set lo up 2>/dev/null || true
[ -z "$(tail -n +2 /proc/self/net/route)" ] && ok "offline (no IPv4 route)" || setup "network route present"
(cd $ST && sha256sum -c --quiet SHA256SUMS) && ok "closure stage == SHA256SUMS" || setup "closure stage manifest"
(cd $ST2 && sha256sum -c --quiet SHA256SUMS) && ok "r2 == r2/SHA256SUMS" || setup "r2 manifest"
(cd $R12 && sha256sum -c --quiet SHA256SUMS) && ok "r12 stage unchanged (frozen)" || setup "r12 stage manifest"
grep -qE '^(## summary|RESULT:)' $LOG && [ -s $X/RECEIPTS.sha256 ] && [ -s $X/RESULTS.tsv ] || setup "r12 run has not finished (no summary/RECEIPTS.sha256): run this afterwards"
(cd $X && sha256sum -c --quiet RECEIPTS.sha256) && ok "r12 results/receipts unchanged" || setup "r12 RECEIPTS.sha256 does not verify"
FORGE=/home/steven/.foundry/bin/forge SOLC=/home/steven/.local/share/svm/0.8.35/solc-0.8.35
[ "$(sha256sum < $FORGE | cut -c1-64)" = 4f77da0810de94325734855d0ad58d70640aa8a5b2a837608ddf8c26da34355c ] && $FORGE --version | grep -q 4072e48705af9d93e3c0f6e29e93b5e9a40caed8 && ok "forge 1.7.1 (4072e487) pinned" || setup "forge is not the pinned one"
[ "$(sha256sum < $SOLC | cut -c1-64)" = fa8ac9a32d301ad023a36ee5a29f8e291fe3200c60244e43c142539e82a617f4 ] && $SOLC --version | grep -q '0.8.35+commit.47b9dedd' && ok "solc 0.8.35+commit.47b9dedd pinned" || setup "solc is not the pinned one"
export PATH=/home/steven/.foundry/bin:/usr/bin:/bin
[ "$(command -v forge)" = $FORGE ] && [ "$(sha256sum < "$(command -v anvil)" | cut -c1-64)" = 10c1c727d6c1de973aeb160e59875b9a9a23464d6e74149ee8abb30b3500311b ] && ok "PATH forge/anvil are the pinned binaries (rig runtime builds)" || setup "PATH forge/anvil are not the pinned ones"
OUT=$ST2/run/$(date -u +%Y%m%dT%H%M%SZ); [ ! -e $OUT ] || setup "run dir exists"; mkdir -p $OUT/trees $OUT/tmp $OUT/logs; export TEST_TMP=$OUT/tmp TMPDIR=$OUT/tmp
# ---- 1+2: derived missing set and the impacted selection (python, read only) -------------------------------------------------
python3 -I - $ST $X $OUT <<'PY' || setup "selection: see above (HOLD)"
import csv, glob, os, re, sys
ST, X, OUT = sys.argv[1:4]
need = {l.strip() for l in open(f'{ST}/map/needed-main-r12.txt') if l.strip()}
produced = None
for f in glob.glob(f'{X}/ARTIFACTS-*.sha256'):
    s = {l.split()[1][len('out/'):] for l in open(f) if l.strip()}
    produced = s if produced is None else produced & s                 # an artifact counts only if EVERY tree has it
missing = sorted(need - (produced or set())); pinned = sorted(l.strip() for l in open(f'{ST}/map/r12-missing.txt') if l.strip())
print(f'  derived r12-missing: {missing}')
if missing != pinned: print(f'  HOLD: derived missing set != map/r12-missing.txt {pinned}'); sys.exit(1)
M = set()
for r in csv.reader((l for l in open(f'{ST}/map/ARTIFACT-MAP.tsv') if not l.startswith('#')), delimiter='\t'):
    root, art, kind, label, test, loc = r
    if root == 'main' and art in missing and label != 'mcp-base':
        M.add(('final' if label == 'final' else label[len('comp-'):], test))
rec = {}
for r in csv.reader(open(f'{X}/receipts/RECEIPTS.tsv'), delimiter='\t'):
    rec[(r[1], r[2])] = r[0]
SUM = re.compile(r'^(\d+) pass=(\d+) fail=(\d+) skip=(\d+) todo=(\d+) cancelled=(\d+)$')
def clean(s):
    m = SUM.match(s.strip()); return bool(m) and m.group(1) == '0' and int(m.group(2)) > 0 and m.group(3) == m.group(4) == m.group(5) == m.group(6) == '0'
def enoent(tree, test):
    k = rec.get((tree, test)); p = f'{X}/receipts/{k}.out' if k else None
    return bool(p and os.path.exists(p) and any(f'contracts/foundry/out/{a}' in open(p, errors='replace').read() and 'ENOENT' in open(p, errors='replace').read() for a in missing))
sel, rows = [], list(csv.reader(open(f'{X}/RESULTS.tsv'), delimiter='\t'))
for i, r in enumerate(rows):
    if r[0] == 'NATIVE' and len(r) == 3 and r[2].startswith('rc '): continue      # F2 native-input rows: never artifact rows
    if r[0] == 'STACK' and len(r) == 3 and r[2].startswith('final: '): pairs = [('final', r[1], r[2].split(': ', 1)[1])]; verdict = 'ok' if clean(pairs[0][2]) else 'FAIL'
    elif r[0] == 'REGRESS' and len(r) == 5 and re.match(r'baseline\(([^)]*)\): ', r[2]) and r[3].startswith('final: '):
        bt = re.match(r'baseline\(([^)]*)\)', r[2]).group(1); pairs = [('final', r[1], r[3].split(': ', 1)[1])]
        if bt not in ('none', ''): pairs.append((bt, r[1], r[2].split(': ', 1)[1]))
        verdict = r[4]
    elif len(r) == 5 and r[2].startswith('component: ') and r[3].startswith('final: '): pairs = [(r[0], r[1], r[2].split(': ', 1)[1]), ('final', r[1], r[3].split(': ', 1)[1])]; verdict = r[4]
    else: print(f'  HOLD: RESULTS row {i} has an unknown shape: {r[:3]}'); sys.exit(1)
    if verdict.startswith('ok') or not any((t, s) in M for t, s, _ in pairs): continue
    if not any(enoent(t, s) for t, s, _ in pairs): print(f'  row {i} {r[0]} {r[1]}: not ok but NO missing-artifact ENOENT -> unrelated, kept'); continue
    for t, s, summ in pairs:
        sel.append((i, t, s, 'rerun' if not clean(summ) else 'reuse', rec.get((t, s), '-'), summ))
with open(f'{OUT}/SELECTED.tsv', 'w') as f:
    for x in sel: f.write('\t'.join(map(str, x)) + '\n')
print(f'  impacted rows: {len({x[0] for x in sel})}; pairs to rerun: {sum(x[3] == "rerun" for x in sel)}; clean r12 pairs reused: {sum(x[3] == "reuse" for x in sel)}')
if not any(x[3] == 'rerun' for x in sel): print('  nothing to rerun'); open(f'{OUT}/NOTHING', 'w').close()
PY
cat $OUT/SELECTED.tsv
TREES=$(awk -F'\t' '$4=="rerun"{print $2}' $OUT/SELECTED.tsv | sort -u)
# ---- 3: private copies, identity gates, the missing source compiled with bytecode gates -----------------------------------------
objs() { python3 -I - "$1" <<'PY'
import json, os, sys
o = os.path.join(sys.argv[1], 'contracts/foundry/out'); d = {}
for r, _, fs in os.walk(o):
    for f in fs:
        p = os.path.join(r, f); rel = os.path.relpath(p, o)
        if rel.startswith('build-info/') or not f.endswith('.json'): continue
        j = json.load(open(p)); d[rel] = [j.get('bytecode', {}).get('object'), j.get('deployedBytecode', {}).get('object')]
print(json.dumps(d, sort_keys=True))
PY
}
outman() { (cd $1/contracts/foundry && find out -type f | LC_ALL=C sort | xargs -r sha256sum); }
SRC=contracts/foundry/test/EnclaveDeployments.multicallValue.t.sol
for t in $TREES; do
  cp -a $X/trees/$t $OUT/trees/$t || setup "copy $t"
  [ "$(git -C $X/trees/$t rev-parse HEAD)" = "$(git -C $OUT/trees/$t rev-parse HEAD)" ] || setup "$t: copy HEAD differs"
  diff <(git -C $X/trees/$t status --porcelain=v1 --ignored | LC_ALL=C sort) <(git -C $OUT/trees/$t status --porcelain=v1 --ignored | LC_ALL=C sort) >/dev/null || setup "$t: copy status differs"
  cmp -s <(outman $X/trees/$t) <(outman $OUT/trees/$t) || setup "$t: copy out/ differs"
  (cd $OUT/trees/$t && sha256sum -c --quiet $ST/map/ADDED-SOURCES-r12.sha256) || setup "$t: source closure != ADDED-SOURCES-r12.sha256"
  git -C $OUT/trees/$t status --porcelain=v1 | LC_ALL=C sort > $OUT/tracked-before-$t.txt; objs $OUT/trees/$t > $OUT/objs-before-$t.json
  (cd $OUT/trees/$t && FOUNDRY_OFFLINE=true timeout -k 10 1200 $FORGE build --offline -j 1 --use $SOLC "$SRC") > $OUT/logs/forge-$t.log 2>&1 || setup "forge build $SRC ($t): $(tail -2 $OUT/logs/forge-$t.log | tr '\n' ' ')"
  objs $OUT/trees/$t > $OUT/objs-after-$t.json
  cmp -s $OUT/tracked-before-$t.txt <(git -C $OUT/trees/$t status --porcelain=v1 | LC_ALL=C sort) || setup "$t: the build changed tracked files"
  python3 -I - $OUT/objs-before-$t.json $OUT/objs-after-$t.json $OUT/trees/$t $ST/map/r12-missing.txt <<'PY' > $OUT/BUILD-$t.txt || { cat $OUT/BUILD-$t.txt; setup "$t: artifact gates"; }
import json, os, sys
b, a = json.load(open(sys.argv[1])), json.load(open(sys.argv[2])); root = sys.argv[3]
bad = [k for k in b if a.get(k) != b[k]]
if bad: print('pre-existing artifacts changed bytecode:', bad[:5]); sys.exit(1)
for rel in (l.strip() for l in open(sys.argv[4]) if l.strip()):
    j = json.load(open(os.path.join(root, 'contracts/foundry/out', rel))); raw = json.loads(j['rawMetadata'])
    assert j['bytecode']['object'].startswith('0x') and len(j['bytecode']['object']) > 2, rel
    assert raw['compiler']['version'] == '0.8.35+commit.47b9dedd', raw['compiler']
    assert raw['settings']['compilationTarget'] == {'contracts/foundry/test/EnclaveDeployments.multicallValue.t.sol': rel.split('/')[1][:-5]}, raw['settings']['compilationTarget']
    print(f'required {rel} bytecode {len(j["bytecode"]["object"]) // 2 - 1} bytes, solc 0.8.35, target exact')
print(f'new artifacts: {sorted(set(a) - set(b))}')
PY
  cat $OUT/BUILD-$t.txt; outman $OUT/trees/$t > $OUT/ARTIFACTS-after-$t.sha256; ok "$t: copy identical to r12's tree; missing source built; gates hold"
done
[ -e $OUT/NOTHING ] || [ "$(for t in $TREES; do python3 -I -c "import json,sys;print(json.load(open(sys.argv[1]))['EnclaveDeployments.multicallValue.t.sol/MockFeed.json'])" $OUT/objs-after-$t.json; done | sort -u | wc -l)" = 1 ] && ok "MockFeed bytecode identical in every copy" || setup "MockFeed bytecode differs between copies"
# ---- 4: rerun exactly the unclean impacted pairs; completeness against the r12 receipt counts; amended results -------------------
rc=0
# r2: the heartbeat negative control's EXACT historical base supervisor, only in the private copies that rerun that test
HB=test/offchain-heartbeat-writers.test.mjs HBP=6f2c7da466dc26e5f7aac88c574a6b807e1a03df HBB=3ad766906ea1dc34dc6b8010370b15ee7d47b6da HBF=supervisor.base-6f2c7da46.js
for t in $(awk -F'\t' -v hb=$HB '$4=="rerun" && $3==hb {print $2}' $OUT/SELECTED.tsv | sort -u); do
  [ "$(git -C $OUT/trees/$t rev-parse $HBP^:supervisor.js)" = $HBB ] || setup "$t: $HBP^:supervisor.js is not blob $HBB"
  [ ! -e $OUT/trees/$t/$HBF ] || setup "$t: $HBF already exists"
  git -C $OUT/trees/$t cat-file blob $HBB > $OUT/trees/$t/$HBF && [ "$(git -C $OUT/trees/$t hash-object $OUT/trees/$t/$HBF)" = $HBB ] || setup "$t: base supervisor not written exactly"
  echo "$HBB  trees/$t/$HBF" >> $OUT/HB-BASE.txt; ok "$t: base supervisor $HBB at the copied tree root (heartbeat negative control only)"; done
while IFS=$'\t' read -r row tree test mode key summ; do
  [ "$mode" = rerun ] || continue
  log=$OUT/logs/rerun--$tree--$(echo $test | tr / _).tap
  if [ "$test" = $HB ]; then (cd $OUT/trees/$tree && OFFCHAIN_HEARTBEAT_BASE_SUPERVISOR=$OUT/trees/$tree/$HBF timeout -k 10 600 node --test --test-reporter=tap --test-timeout=300000 "$test") > $log 2>&1; nrc=$?
  else (cd $OUT/trees/$tree && timeout -k 10 600 node --test --test-reporter=tap --test-timeout=300000 "$test") > $log 2>&1; nrc=$?; fi
  echo -e "$row\t$tree\t$test\t$nrc\t$(sha256sum < $log | cut -c1-64)" >> $OUT/RERUN.tsv
done < $OUT/SELECTED.tsv
python3 -I - $X $OUT <<'PY'; rc=$?
import csv, os, re, sys
X, OUT = sys.argv[1:3]
SUM = re.compile(r'^(\d+) pass=(\d+) fail=(\d+) skip=(\d+) todo=(\d+) cancelled=(\d+)$')
def tap(p):
    t = open(p, errors='replace').read(); return {k: int(v) for k, v in re.findall(r'^# (tests|pass|fail|cancelled|skipped|todo) (\d+)$', t, re.M)}
def clean(s):
    m = SUM.match(s.strip()); return bool(m) and m.group(1) == '0' and int(m.group(2)) > 0 and m.group(3) == m.group(4) == m.group(5) == m.group(6) == '0'
sel = [r for r in csv.reader(open(f'{OUT}/SELECTED.tsv'), delimiter='\t')] if os.path.getsize(f'{OUT}/SELECTED.tsv') else []
rer = {(r[1], r[2]): r for r in csv.reader(open(f'{OUT}/RERUN.tsv'), delimiter='\t')} if os.path.exists(f'{OUT}/RERUN.tsv') else {}
fixed, failed, verdict = {}, False, {}
for row, tree, test, mode, key, summ in sel:
    if mode == 'reuse': verdict.setdefault(row, []).append(True); continue
    want = tap(f'{X}/receipts/{key}.out').get('tests') if key != '-' else None
    r = rer.get((tree, test)); g = tap(f'{OUT}/logs/rerun--{tree}--{test.replace("/", "_")}.tap') if r else {}
    good = bool(r) and r[3] == '0' and want and g.get('tests') == want and g.get('pass') == want and all(g.get(k, 1) == 0 for k in ('fail', 'cancelled', 'skipped', 'todo'))
    print(f'  rerun {tree} {test}: rc {r[3] if r else "-"} {g} (r12 receipt # tests {want}) -> {"PASS" if good else "NOT CLEAN"}')
    failed |= not good; verdict.setdefault(row, []).append(good)
rows = list(csv.reader(open(f'{X}/RESULTS.tsv'), delimiter='\t')); remaining = 0
with open(f'{OUT}/RESULTS-AMENDED.tsv', 'w') as f:
    for i, r in enumerate(rows):
        v = verdict.get(str(i))
        if v is not None: new = 'ok(amended: missing artifact closed; rerun)' if all(v) else 'NOT-CLEAN(amended rerun)'
        elif r[0] == 'STACK': new = 'ok' if clean(r[2].split(': ', 1)[1]) else 'FAIL'
        elif r[0] == 'NATIVE': new = 'ok' if r[2] == 'rc 0 OK' else 'FAIL'   # F2's own row; its skip refusal is a separate r12 [FAIL] line
        else: new = r[-1]
        remaining += not new.startswith('ok'); f.write('\t'.join(r + [new]) + '\n')
print(f'  amended rows: {len(rows)} total, {len(verdict)} amended, {remaining} still not ok')
sys.exit(1 if failed else (3 if remaining else 0))
PY
OTHER=$(grep -c '^\[FAIL\]' $LOG); echo "  r12 phase [FAIL] lines (not artifact rows; unchanged by this job): $OTHER"
(cd $OUT && sha256sum SELECTED.tsv RESULTS-AMENDED.tsv BUILD-*.txt ARTIFACTS-after-*.sha256 $( [ -e RERUN.tsv ] && echo RERUN.tsv ) $( [ -e HB-BASE.txt ] && echo HB-BASE.txt ) logs/* > RECEIPTS.sha256)
[ $rc = 0 ] && [ "$OTHER" != 0 ] && rc=3
case $rc in 0) echo "RESULT: PASS (every r12 row ok after the amendment; no other r12 failure)";; 3) echo "RESULT: IMPACTED-FIXED, r12 STILL NOT PASSING (unrelated rows/phase failures remain)";; *) echo "RESULT: FAIL";; esac
exit $rc
