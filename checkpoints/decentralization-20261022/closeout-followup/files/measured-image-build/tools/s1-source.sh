#!/usr/bin/env bash
# s1 (queue 256): a NEW shallow local checkout of the published commit (the checkpoint clone is only read), its identity, and
# the exact path delta against the reviewed tree-c capture (3031c20c; out/c/capture-ls-tree.txt).
set -euo pipefail
. "$(dirname "$0")/env.sh"
R=/home/steven/Documents/Codex/2026-10-18/wo/work/source-checkpoint-20261022/main-repo
C=6f2c7da466dc26e5f7aac88c574a6b807e1a03df; TREE=0021f3abbe1e3dfc121032189c6434c1d093d3f0; BR=candidate/decentralized-control-20261022
[ ! -e "$B/src" ] || { echo "src exists"; exit 2; }
git -C "$R" rev-parse "$C^{tree}" | grep -qx "$TREE"
git clone -q --depth 1 --no-tags --single-branch --branch "$BR" "file://$R" "$B/src"
git -C "$B/src" remote remove origin
[ "$(git -C "$B/src" rev-parse HEAD)" = "$C" ] || { echo "branch tip is not $C"; exit 4; }
git -C "$B/src" checkout -q --detach "$C"
[ "$(git -C "$B/src" rev-parse HEAD^{tree})" = "$TREE" ]
[ -z "$(git -C "$B/src" status --porcelain --untracked-files=all)" ]
git -C "$B/src" log -1 --format='commit %H%ntree %T%nparent %P%nauthor %an %aI%ncommitter %cn %cI%nsubject %s' > "$B/receipts/source-commit.txt"
git -C "$B/src" ls-tree -r HEAD > "$B/receipts/published-ls-tree.txt"
python3 - "$B" <<'PY'
import json,sys
B=sys.argv[1]
def rd(p): return {l.split('\t',1)[1]:l.split('\t',1)[0] for l in open(p).read().splitlines()}
a=rd('/home/steven/Documents/Codex/2026-10-18/wo/work/resume-after-checkpoint-20261022/measured-composition/out/c/capture-ls-tree.txt'); b=rd(B+'/receipts/published-ls-tree.txt')
d={p:{'treeC':a.get(p),'published':b.get(p)} for p in sorted(set(a)|set(b)) if a.get(p)!=b.get(p)}
want=['.gitleaks.toml','isolation/m2/encvol/roots/cacert-2026-09-25.pem','test/helpers/platform-policy-world.mjs','test/platform-policy-world-blocks.test.mjs']
json.dump({'deltaVsTreeC3031c20c':d,'expectedFour':want,'exactlyTheFour':sorted(d)==sorted(want),'treeCPaths':len(a),'publishedPaths':len(b)},open(B+'/receipts/source-delta.json','w'),indent=1)
print(json.dumps({'paths':sorted(d),'exactlyTheFour':sorted(d)==sorted(want),'kinds':{p:('added' if v['treeC'] is None else 'removed' if v['published'] is None else 'changed') for p,v in d.items()}},indent=1))
if sorted(d)!=sorted(want): sys.exit(5)
PY
cat "$B/receipts/source-commit.txt"; echo "S1-OK; stub invocations: $(( $(wc -l < "$B/stub/invocations.log") - STUB_BASE ))"
