p='jobs/r7-build-validate.sh'; s=open(p).read()
def rep(a,b):
    global s; assert s.count(a)==1,(a[:90],s.count(a)); s=s.replace(a,b)
rep('# r6 = r5 (frozen)','# r7 = r6 (frozen) on the r7 candidate c154f05c (parent c4de37a3: restores the route-unique lines the r2 route-first-base merge lost,\n#   R7-RESOLUTIONS.json) + static bundle-entry link gates before and after regeneration + the Windows chain-reader regression test.\n#   Private r7/src.git (objects via alternates to the frozen r3/src.git). Every r6 guard, pin, order, native input and no-skip rule kept.\n# r6 text follows. r6 = r5 (frozen)')
rep('R3=$S/r3; R4=$S/r6; G=$R3/src.git','R3=$S/r3; R4=$S/r7; G=$R4/src.git')
rep('need "r6 files == SHA256SUMS"','need "r7 files == SHA256SUMS"')
rep('need "r3 private refs == r3/REFS.txt" bash -c "diff <(git --git-dir=$G for-each-ref --format=\'%(objectname) %(refname)\') $R3/REFS.txt"',
    'need "r3 private refs == r3/REFS.txt (frozen)" bash -c "diff <(git --git-dir=$R3/src.git for-each-ref --format=\'%(objectname) %(refname)\') $R3/REFS.txt"\nneed "r7 private refs == r7/REFS.txt" bash -c "diff <(git --git-dir=$G for-each-ref --format=\'%(objectname) %(refname)\') $R4/REFS.txt"\nneed "r6 stage unchanged (frozen; its runner is the base of this one)" bash -c "cd $S/r6 && sha256sum -c --quiet SHA256SUMS"')
rep('[final]=refs/r3/candidate)','[final]=refs/r7/candidate)')
rep('need "candidate is the r3 candidate c4de37a3" [ "${SHA[final]}" = c4de37a3f97a3350b6e6a30fbc1f9ada66e2c91f ]',
    'need "candidate is r7 c154f05c, child of c4de37a3, changing exactly the 4 reconciled files" bash -c "[ ${SHA[final]} = c154f05c3303a5e1baabec1fe38f90a7aec6d11e ] && [ \\"\\$(git --git-dir=$G rev-parse ${SHA[final]}^)\\" = c4de37a3f97a3350b6e6a30fbc1f9ada66e2c91f ] && [ \\"\\$(git --git-dir=$G diff --name-only c4de37a3f97a3350b6e6a30fbc1f9ada66e2c91f ${SHA[final]} | tr \'\\n\' \' \')\\" = \'PRODUCT.md docs/network/measured-control-guest.md network/attested-verifier-client.mjs network/host-admission-node.mjs \' ]"\nneed "r7 commit message pins R7-RESOLUTIONS.json" bash -c "git --git-dir=$G log -1 --format=%B ${SHA[final]} | grep -qx \\"R7-Resolutions-Sha256: \\$(sha256sum < $R4/R7-RESOLUTIONS.json | cut -c1-64)\\""\nneed "static: every bundle importer names only exports of the bundle\'s SOURCE entry" python3 -I $R4/tools/bundle-entry-links.py $G ${SHA[final]}')
rep('cp $R3/stack-tests/*.mjs $F/test/','cp $R4/stack-tests/*.mjs $F/test/')
rep('FINAL=$(git -C $F rev-parse HEAD); echo "[ok] regenerated candidate $FINAL', '''FINAL=$(git -C $F rev-parse HEAD)
python3 -I $R4/tools/link-check.py $F/.git HEAD > $X/link-after.json || true
python3 -I - $X/link-after.json $R4/LINK-BASELINE.json <<'PY' || fail=1
import json, sys
key = lambda x: (x["importer"], x["target"], tuple(x["missing"]))
base = {key(x) for x in json.load(open(sys.argv[2]))}; new = [x for x in json.load(open(sys.argv[1])) if key(x) not in base]
for x in new: print("[FAIL] regenerated tree: import not satisfied:", x)
print(f"[{'ok' if not new else 'FAIL'}] regenerated tree: no import/export link beyond the heads' baseline"); sys.exit(1 if new else 0)
PY
echo "[ok] regenerated candidate $FINAL''')
rep('STACK="test/stack-provider-authority.test.mjs','STACK="test/stack-windows-chain-reader.test.mjs test/stack-provider-authority.test.mjs')
open(p,'w').write(s)
