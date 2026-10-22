#!/bin/sh
# Final evidence (read-only over candidate/main): full candidate source-hash listing, platform-api sidecar by its recorded
# source, main drift since the stage3 capture (regular files, same predicate as stage3), candidate tree re-derivation.
set -e
H=/home/steven/Documents/Codex/2026-10-18/wo/work/resume-20261021/reconciliation; C=$H/../reconciled-candidate; M=/home/steven/Documents/Codex/2026-10-18/wo/work/enclave; L=/home/steven/Documents/Codex/2026-10-18/wo/work/linux-combined-release
export GIT_OPTIONAL_LOCKS=0
(cd $C && find . \( -type f -o -type l \) -print0 | sort -z | xargs -0 sha256sum) > $H/candidate-all.sha256
echo "CANDIDATE-FILES $(wc -l < $H/candidate-all.sha256) listing-sha256 $(sha256sum < $H/candidate-all.sha256 | cut -c1-64)"
python3 - $C <<'PY'
import json,hashlib,sys
C=sys.argv[1]; d=json.load(open(C+'/metal/guest/platform-api.bundle.mjs.manifest.json'))
for k,v in d['sidecars'].items():
    print('SIDECAR',k,'source',v['source'],'matches' if hashlib.sha256(open(C+'/'+v['source'],'rb').read()).hexdigest()==v['sha256'] else 'DIFFERS')
PY
(cd "$M" && find . \( -name node_modules -o -name .git -o -name __pycache__ \) -prune -o -type f -print0 | sort -z | xargs -0 sha256sum) > $H/main-now.sha256
cmp -s $L/main-capture-v3-after.sha256 $H/main-now.sha256 && echo "MAIN-UNCHANGED-SINCE-STAGE3-CAPTURE" || { echo "MAIN-PATHS-CHANGED-SINCE-STAGE3-CAPTURE:"; diff $L/main-capture-v3-after.sha256 $H/main-now.sha256 | grep '^[<>]' | awk '{print $3}' | sort -u; }
I=$H/rederive.index; rm -f $I
GIT_INDEX_FILE=$I GIT_WORK_TREE=$C git --git-dir $H/upstream.git read-tree 7752a4239b3bec2cf452491cd1b95164a8c2bdb8
GIT_INDEX_FILE=$I GIT_WORK_TREE=$C git --git-dir $H/upstream.git add -A -f .
T=$(GIT_INDEX_FILE=$I git --git-dir $H/upstream.git write-tree); rm -f $I
[ "$T" = cf00054aa76ddabf97af0c955d89d79bfa4caeab ] && echo "CANDIDATE-DIR RE-DERIVES TREE $T" || { echo "RE-DERIVED TREE $T != cf00054a"; exit 1; }
git --git-dir $H/upstream.git diff-tree -r --no-renames --stat=200 7752a4239b3bec2cf452491cd1b95164a8c2bdb8 $T | tail -1
echo EVIDENCE-OK
