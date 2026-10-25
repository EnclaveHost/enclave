#!/bin/bash
# Negative controls for the resume tooling (no compile; every case must be REFUSED before cargo runs). Via the 256 MiB queue:
#   python3 work/claude-test-queue.py --mib 256 --log $R/logs/refusals.guard -- unshare -rn bash $R/test-refusals-4096.sh  (from recovery-2560/test-refusals.sh 9c5d8c7e)
set -uo pipefail
R=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/finality-stage/m10-bootstrap/recovery-4096
M=${R%/recovery-4096}; T=$(mktemp -d -p $R refusal.XXXX); trap 'rm -rf "$T"' EXIT; rc=0
ok() { echo "[ok] $1"; }; bad() { echo "[FAIL] $1"; rc=1; }
F='-C link-arg=-Wl,--threads=1'
cp $M/jobs/root-test-m10.sh $T/job.sh; echo "# x" >> $T/job.sh
python3 -I $R/make-resume-body-4096.py $T/job.sh $T/body.sh >/dev/null 2>&1 && bad "1 generator accepted a changed job" || ok "1 generator refuses a job that is not 51ffbda2"
sed 's/--test-threads=2/--test-threads=8/' $R/resume-body-4096.sh > $T/body2.sh
python3 -I $R/make-resume-body-4096.py --check $M/jobs/root-test-m10.sh $T/body2.sh && bad "2 --check accepted a tampered body" || ok "2 --check refuses a body with a changed test option"
run() { env -u RUSTFLAGS -u CARGO_BUILD_JOBS "$@" bash $R/resume-4096.sh > $T/o 2>&1; echo $?; }
r=$(run CARGO_BUILD_JOBS=1 RESUME=dry8 DRY=1); grep -q 'need CARGO_BUILD_JOBS=1 and the original RUSTFLAGS' $T/o && [ $r = 1 ] && ! grep -q 'build/tree ==' $T/o && ok "3 missing RUSTFLAGS refused before step 0" || { bad "3 rc=$r"; tail -3 $T/o; }
r=$(run CARGO_BUILD_JOBS=2 RUSTFLAGS="$F" RESUME=dry8 DRY=1); grep -q 'need CARGO_BUILD_JOBS=1' $T/o && [ $r = 1 ] && ok "4 two compiler jobs refused" || { bad "4 rc=$r"; tail -3 $T/o; }
r=$(run CARGO_BUILD_JOBS=1 RUSTFLAGS="$F" RESUME=1 DRY=1); grep -q 'DRY needs RESUME=dry' $T/o && [ $r = 1 ] && ok "5 DRY cannot consume a real attempt number" || { bad "5 rc=$r"; tail -3 $T/o; }
r=$(run CARGO_BUILD_JOBS=1 RUSTFLAGS="$F" RESUME=1); grep -q 'running under the 4096 MiB allocation' $T/o && grep -q 'RESUME REFUSED' $T/o && [ $r = 1 ] && ! grep -q '== resume body' $T/o && ok "6 a real run outside a 4096 MiB cgroup is refused before the body ($(grep -o 'memory.max [0-9]*' $T/o))" || { bad "6 rc=$r"; tail -3 $T/o; }
[ ! -e $R/logs/run-1 ] && [ ! -e $R/logs/resume-1.rc ] && [ ! -e $R/regen-1 ] && [ ! -e $R/regen-dry8 ] && ok "7 refusals created no attempt logs or regeneration dirs" || bad "7 leftovers"
echo "## refusals rc=$rc"; exit $rc
