#!/bin/bash
set -euo pipefail
cd /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025
P=$PWD; B=$P/../resume-after-checkpoint-20261022
S=$P/canonical-build-recipe-stage; X=$S/run/tests-20261026T010959Z
python3 - <<'PY'
import pathlib,json,hashlib
s=pathlib.Path('canonical-build-recipe-stage')
for f,d in json.loads((s/'r2/PINS.json').read_text()).items():assert hashlib.sha256(pathlib.Path(f).read_bytes()).hexdigest()==d,f
for n in ['R1-check-candidate','R2-check-77d6cc859-control']:
 p=s/'run/tests-20261026T010959Z/logs'
 assert (p/(n+'.rc')).read_text().strip()=='0'
 assert 'CLOSURE_CHECK_OK' in (p/(n+'.out')).read_text()
assert pathlib.Path('logs/root-canonical-build-recipe-0116.rc').read_text().strip()=='1'
PY
env CAND_TREE="$X/cand" BASE_TREE="$X/base" HREPO="$B/witness-failover/helios" LREPO="$B/rpc-gossip-bridge/listener" TARBALL="$B/rpc-runtime-final-integration/closure/src/base-5476069f.tar.gz" python3 -I "$S/r2/test-build-recipe.py" > "$S/r2/plumbing.out" 2>&1
cat "$S/r2/plumbing.out"
grep -q '^Ran 11 tests' "$S/r2/plumbing.out"
grep -q '^OK$' "$S/r2/plumbing.out"
! grep -qiE 'skipped|expected failure' "$S/r2/plumbing.out"
printf '%s\n' 'PASS: 11 corrected plumbing checks plus both unchanged actual offline Cargo closure checks; original root0116 failure retained'
