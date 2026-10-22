#!/usr/bin/env bash
# Candidate harness against: (1) main's deployed-equivalent bundle, (2) main source, (3) the candidate source (scratch copy).
set -uo pipefail
R=/home/steven/Documents/Codex/2026-10-18/wo/work/cron-startup-20261021/host-policy-review; E=/home/steven/Documents/Codex/2026-10-18/wo/work/enclave
export TMPDIR=$R/tmp; cd $R/scratch
for v in "bundle-main:$E/windows/node/host-admission.bundle.mjs" "source-main:$E/network/host-admission-runtime.mjs" "candidate:$R/scratch/network/host-admission-runtime.mjs"; do
  n=${v%%:*}; m=${v#*:}; echo "=== $n ($m)"
  ADMISSION_MODULE=$m timeout 600 node --test --test-concurrency=1 test/admission-quorum.test.mjs > $R/out-$n.txt 2>&1; echo "$n rc=$?"
  grep -E "^# (pass|fail)|^not ok|^ok|# METRIC" $R/out-$n.txt
done
