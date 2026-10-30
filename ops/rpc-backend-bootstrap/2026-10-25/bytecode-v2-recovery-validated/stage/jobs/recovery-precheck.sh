#!/bin/bash
# RECOVERY precheck (read-only). Refuses unless: the original v2 stage, its failure receipts and its 4 GiB fixture evidence
# are exactly as pinned; the original job has ended; the recovery product sources (lib.rs, main.rs, Cargo.toml), control,
# lock/closure inputs and helper jobs are byte-identical to the original; tests.rs and the resume job are exactly the
# counted derivations of the originals. Usage: bash recovery-precheck.sh   (sources env.sh for S and O)
set -uo pipefail
. "$(dirname "$0")/env.sh"; W=${S%/finality-stage/bytecode-v2-recovery}; rc=0
ok() { echo "[ok] $1"; }; bad() { echo "[REFUSE] $1"; rc=1; }
h() { sha256sum < "$1" | cut -c1-64; }
pin() { [ "$(h "$1")" = "$2" ] && ok "$(basename "$1") ${2:0:8}" || bad "$1 is not ${2:0:8}"; }
echo "== original v2 stage (read-only) and its failure"
pin $O/inputs/STAGE-SHA256SUMS 051e8fccdb89cc589b94754143e0dab4bbbc569c1a670d8c4f76a94a167caa44
(cd $O && sha256sum -c --quiet inputs/STAGE-SHA256SUMS) && ok "original stage files == its STAGE-SHA256SUMS" || bad "original stage files changed"
pin $W/logs/root-bytecode-v2-native-2249.out 2a5aca4eb8e366723f7e7f532906b97dff8ef9f217a03df321fe264744cf50ce
[ "$(cat $W/logs/root-bytecode-v2-native-2249.rc)" = 143 ] && ok "original outer rc 143" || bad "original rc is not 143"
grep -q '^## patched test binary sha256 29df9018ae3128bc8e07ede84dc343cd6b30308cef1549b01a25c789355169f5$' $W/logs/root-bytecode-v2-native-2249.out && grep -q '^\[queue\] EXIT -15$' $W/logs/root-bytecode-v2-native-2249.out && ! grep -q '^## aggregate rc=' $W/logs/root-bytecode-v2-native-2249.out \
  && ok "original: test binary 29df9018 built, queue EXIT -15, no aggregate result" || bad "original receipt content differs"
[ ! -e $W/logs/root-bytecode-v2-native-2249.guard ] && [ ! -e $O/logs/root-build-test.guard ] && ok "no guard receipt (cgroup OOM, as recorded)" || bad "a guard receipt exists: re-review"
pin $O/logs/patched.test.out ea787c2b23cc664aa8db74890021159ce97d8f40c36cb9edd838a77a248d2b26
[ "$(grep -c '^test tests::.* \.\.\. ok$' $O/logs/patched.test.out)" = 20 ] && ! grep -q '^test result' $O/logs/patched.test.out && ok "original: 20 tests ok, no test result line" || bad "original test log differs"
[ "$(stat -c %s $O/build/tmp/base-bytecode-check-61028-v2bytes/db/mdbx.dat)" = 4294967296 ] && ok "original fixture mdbx.dat is 4294967296 bytes (sparse default geometry)" || bad "original fixture evidence changed"
pin $S/evidence/root-oom-scope-lines.txt 71c0e661e8fdd456a4306974d80ad266a56e2c6ec1c7b31998da25776e0b568f
grep -qF "run-p49545-i37834870.scope: Failed with result 'oom-kill'." $O/logs/root-oom-evidence.out && ok "root journal: run-p49545-i37834870.scope oom-kill" || bad "journal evidence differs"
[ -z "$(pgrep -f "$O/jobs/root-build-test.sh" || true)" ] && ok "original job has ended (no process)" || bad "original job still running"
[ -d $O/build/target/debug ] && ok "original target present (to be COPIED, never written)" || bad "original target missing"
echo "== recovery inputs == original (product unchanged)"
for f in crate/Cargo.toml crate/src/lib.rs crate/src/main.rs control/disable_check.py inputs/closure-manifest.json jobs/artifact.py jobs/insert_lock_entry.py jobs/verify_inputs.py; do
  cmp -s $S/$f $O/$f && ok "$f identical to the original" || bad "$f differs from the original"; done
pin $S/crate/src/lib.rs ed9870e7c89b5b8f8ecc9d38ddbc36614dfdcde6fb13e91f1150612feb5312df
pin $S/crate/src/main.rs 05dd717eb6da60ce38c9f852fe7656bb202f5ab985514001e72023eb192de25c
pin $S/crate/Cargo.toml e398c4f97e5f7fdd261a002ab705698f00a9fa086660f9909f42dfcc96e23fc8
python3 -I $S/jobs/make-tests-fix.py --check $O/crate/src/tests.rs $S/crate/src/tests.rs && ok "tests.rs == make-tests-fix.py(original 072a23a8): fixture-only" || bad "tests.rs is not the fixture-only derivation"
python3 -I $S/jobs/make-recovery-job.py --check $O/jobs/root-build-test.sh $S/jobs/root-build-test-recovery.sh && ok "resume job == make-recovery-job.py(original 7c95ec5b)" || bad "resume job is not the counted derivation"
[ ! -e $B ] && ok "recovery build dir is new" || bad "$B exists"
echo "## recovery precheck rc=$rc"; exit $rc
