#!/usr/bin/env bash
# Offline regression of the reviewed Helios pin replacement cc962e2b -> 8250f08a against attested-verifier-source 77d6cc859.
# ROOT-LAUNCHED, FOREGROUND, from work/rpc-production-final-20261025:
#   ./jobs/q-exit-status.sh canonical-integration-regress-N 1024 unshare -rn bash canonical-integration-actual/jobs/integration-regression.sh
# Optional phase E (real binaries in a user-namespace guest root; never assumed): GUEST_ROOTFS=… RIG_CHAIN_NODE=reth RIG_RETH_…=…
# Writes ONLY a fresh run/regress-<UTC>/ (two git-archive trees, a NEW chain-verifier-inputs dir, logs). The source repo,
# its branches/worktrees, the frozen build stage, the old inputs dir, images and host packages are only READ.
# Accept only `## rc=0`. A phase that did not run is NOT RUN, never a pass. This is no image, measurement or SNP evidence.
set -uo pipefail
W=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025; IA=$W/canonical-integration-actual
SRC=$W/attested-verifier-source; C=77d6cc859fbd3dba0fcf28d372e8fe463e5a589c; O=$W/canonical-verifier-binary-stage/run/build-20261026T004633Z/out
OLDV=/home/steven/Documents/Codex/2026-10-18/wo/work/resume-after-checkpoint-20261022/linux-rpc-runtime-launch/chain-verifier-inputs
need() { local w=$1; shift; if "$@"; then echo "[ok] $w"; else echo "[FAIL] $w"; echo "RESULT: PRECHECK-FAILED (nothing tested)"; exit 9; fi; }
ip link set lo up 2>/dev/null || true
need "offline (lo only, no route)" bash -c '[ "$(tail -n +3 /proc/self/net/dev | cut -d: -f1 | tr -d " " | sort | tr "\n" " ")" = "lo " ] && [ -z "$(tail -n +2 /proc/self/net/route)" ]'
need "stage files == SHA256SUMS" bash -c "cd $IA && sha256sum -c --quiet SHA256SUMS"
need "recorded inputs unchanged (jobs/INPUT-PINS.sha256)" bash -c "cd $W && grep -v '^#' $IA/jobs/INPUT-PINS.sha256 | sha256sum -c --quiet"
need "source commit $C present" git -C $SRC cat-file -e $C^{commit}
need "candidate files: 77d6cc859 'before' blobs as recorded" bash -c "while read b a f; do [ \"\$(git -C $SRC show $C:\$f | sha256sum | cut -c1-64)\" = \$b ] && [ \"\$(sha256sum < $IA/candidate/\$f | cut -c1-64)\" = \$a ] || exit 1; done < $IA/SOURCE-FILES.sha256"
X=$IA/run/regress-$(date -u +%Y%m%dT%H%M%SZ); need "fresh $X" [ ! -e $X ]; mkdir -p $X/tmp $X/logs; export TEST_TMP=$X/tmp HOME=$X/tmp
echo "== B: NEW chain-verifier-inputs (frozen prepare script; old dir only read)"
bash $W/canonical-verifier-binary-stage/integration/prepare-chain-verifier-inputs.sh $O $X/chain-verifier-inputs || { echo "RESULT: INPUTS-FAILED"; exit 10; }
echo "== C: trees (git archive of $C; candidate = base + the 5 reviewed files)"
for t in base cand; do mkdir $X/$t; git -C $SRC archive $C | tar -x -C $X/$t; ln -s $SRC/node_modules $X/$t/node_modules; done
while read f; do cp $IA/candidate/$f $X/cand/$f; done < $IA/CHANGED-FILES.txt
need "candidate differs from base in exactly CHANGED-FILES" bash -c "diff <(cd $X && diff -rq base cand | sed -n 's|^Files base/\(.*\) and cand/.* differ$|\1|p' | LC_ALL=C sort) $IA/CHANGED-FILES.txt && [ -z \"\$(cd $X && diff -rq base cand | grep -v '^Files ')\" ]"
cp $IA/tests/canonical-helios-pin.test.mjs $X/cand/test/
for t in base cand; do (cd $X/$t && git init -q && git add -A . ':!node_modules' && GIT_AUTHOR_NAME=regress GIT_AUTHOR_EMAIL=regress@localhost GIT_COMMITTER_NAME=regress GIT_COMMITTER_EMAIL=regress@localhost git -c commit.gpgsign=false commit -qm "throwaway $t tree (never pushed)") || { echo "RESULT: TREE-FAILED"; exit 11; }; done
declare -A RC; ph() { local n=$1 dir=$2; shift 2; echo "== $n"; (cd $dir && timeout -k 10 1200 "$@") > $X/logs/$n.out 2>&1; RC[$n]=$?; printf '%s\n' "${RC[$n]}" > $X/logs/$n.rc; tail -4 $X/logs/$n.out; echo "## $n rc=${RC[$n]}"; }
echo "== D: regression (offline)"
ph D1-provenance $X/cand python3 -I $IA/tests/test-provenance.py
ph D2-source-updater $X/cand python3 -I $IA/tests/test-source-updater.py
ph D3-pin-candidate $X/cand env CANON_BASE_TREE=$X/base CANON_NEW_INPUTS=$X/chain-verifier-inputs CANON_OLD_INPUTS=$OLDV node --test --test-timeout=120000 test/canonical-helios-pin.test.mjs
EXIST="test/rpc-runtime.test.mjs test/chain-authority.test.mjs test/verified-chain.test.mjs test/chain-verifier-guest.test.mjs test/attested-chain-verifier.test.mjs"
ph D4-existing-cand $X/cand node --test --test-timeout=120000 $EXIST
ph D5-existing-base-control $X/base node --test --test-timeout=120000 $EXIST
ph D6-overlay-cand-newinputs $X/cand env CHAIN_VERIFIER_INPUTS=$X/chain-verifier-inputs python3 test/metal-control-overlay.test.py -v
ph D7-overlay-base-oldinputs-control $X/base env CHAIN_VERIFIER_INPUTS=$OLDV python3 test/metal-control-overlay.test.py -v
ph D8-NEG-overlay-cand-oldinputs $X/cand env CHAIN_VERIFIER_INPUTS=$OLDV python3 test/metal-control-overlay.test.py -v ChainVerifierOverlay.test_with_inputs_every_pinned_file_is_installed_with_its_mode_and_digest
grep -qE "skipped|SKIP" $X/logs/D6-overlay-cand-newinputs.out && grep -E "skip" $X/logs/D6-overlay-cand-newinputs.out | head -5
if [ -n "${GUEST_ROOTFS:-}" ] && [ -n "${RIG_CHAIN_NODE:-}" ]; then
  ph E-guest-e2e-cand $X/cand env CHAIN_VERIFIER_INPUTS=$X/chain-verifier-inputs node --test --test-timeout=900000 test/chain-verifier-guest.e2e.test.mjs
  E=${RC[E-guest-e2e-cand]}; grep -q "^# skipped 0" $X/logs/E-guest-e2e-cand.out || E=skipped
else E="NOT RUN (GUEST_ROOTFS/RIG_CHAIN_NODE not provided)"; echo "== E: $E"; fi
(cd $X && sha256sum logs/*.out chain-verifier-inputs/PINS.sha256 > RECEIPTS.sha256)
echo "## summary: $(for k in D1-provenance D2-source-updater D3-pin-candidate D4-existing-cand D5-existing-base-control D6-overlay-cand-newinputs D7-overlay-base-oldinputs-control D8-NEG-overlay-cand-oldinputs; do printf '%s=%s ' $k ${RC[$k]}; done) E=$E"
ok=1; for k in D1-provenance D2-source-updater D3-pin-candidate D4-existing-cand D5-existing-base-control D6-overlay-cand-newinputs D7-overlay-base-oldinputs-control; do [ "${RC[$k]}" = 0 ] || ok=0; done
[ "${RC[D8-NEG-overlay-cand-oldinputs]}" = 1 ] || { echo "[FAIL] negative control: the candidate image pins ACCEPTED the old helios"; ok=0; }
[ "${RC[D5-existing-base-control]}" = 0 ] && [ "${RC[D7-overlay-base-oldinputs-control]}" = 0 ] || echo "[note] a 77d6cc859 control failed: compare before attributing anything to the candidate"
python3 - "$X/logs" <<'CHECK' || ok=0
import pathlib,re,sys
p=pathlib.Path(sys.argv[1])
for n in ['D3-pin-candidate','D4-existing-cand','D5-existing-base-control']:
 s=(p/(n+'.out')).read_text()
 for k in ['fail','cancelled','skipped','todo']:
  assert re.search(r'^# '+k+r' 0$',s,re.M), (n,k)
 assert re.search(r'^# pass [1-9][0-9]*$',s,re.M), n
for n in ['D1-provenance','D2-source-updater','D6-overlay-cand-newinputs','D7-overlay-base-oldinputs-control']:
 s=(p/(n+'.out')).read_text()
 assert re.search(r'^Ran [1-9][0-9]* tests? in ',s,re.M),n
 assert re.search(r'^OK$',s,re.M),n
 assert not re.search(r'\bskipped[ =]',s,re.I),n
s=(p/'D8-NEG-overlay-cand-oldinputs.out').read_text()
assert re.search(r'^Ran 1 test in ',s,re.M)
assert 'FAILED (errors=1)' in s
assert 'test_with_inputs_every_pinned_file_is_installed_with_its_mode_and_digest' in s
assert re.search(r'ValueError: chain verifier input .*?/helios has sha256 cc962e2b97d545930a3c2051aa6e1c5b08a6c43a4b6b8021eead462ac02c07f0, not the pinned 8250f08a7b0e1f2432ea6262903ca3203b60bca6a8e17abd6d9bccbe0dbfa378',s)
print('PASS: complete positive summaries, zero skips, exact old-artifact pin rejection')
CHECK
if [ -n "${GUEST_ROOTFS:-}" ] && [ -n "${RIG_CHAIN_NODE:-}" ]; then [ "$E" = 0 ] || ok=0; fi
[ $ok = 1 ] || { echo "RESULT: REGRESSION-FAILED"; exit 1; }
echo "## rc=0 (candidate pin replacement regressions passed offline; E: $E; NOT committed, NOT an image, NOT measured, NOT SNP-qualified)"
