#!/usr/bin/env bash
# ROOT-LAUNCHED, FOREGROUND (in a session that survives the CLI). Sequential native reproduction, each phase a separate job through the
# shared queue (memory guard, 16 GiB floor; q.sh retries only "not started"), offline (unshare -r -n, lo only), CARGO_BUILD_JOBS=1:
#   r1r          1024  R1 resume: verify + resume interrupted A in place, B fully fresh, compare with the pin 9ca75047   (jobs/r1r.sh)
#   r2b          1536  R2: witness-check at committed ef320298, original paths via a private mount namespace (pin 4fe0cd3b) (jobs/r2.sh)
#   r3-b93fcfd   1536  R3: Helios CLI at committed b93fcfd, original paths (pin cc962e2b)                                     (jobs/r3.sh)
#   r3-eeffcc9   1536  R3: Helios CLI at committed eeffcc9, original paths (pin cc962e2b)                                     (jobs/r3.sh)
# Every phase runs whatever the previous result (they are independent); a guard stop (99) is reported, never bypassed or retried higher.
# Logs: logs/<name>.{out,guard,rc} (+ logs/r1r-*). Summary: logs/resume-summary.txt. Nothing is deleted; no pin or source changes.
set -u
cd "$(dirname "$0")/.."
summary=logs/resume-summary.txt; echo "resume started $(date -u +%FT%TZ)" >> $summary
run() { local mib=$1 name=$2; shift 2; echo "== $(date -u +%FT%TZ) $name"; "$@"; local rc=$?
  echo "$(date -u +%FT%TZ) $name rc=$rc $(grep -h '\[result\]' logs/$name.out 2>/dev/null | tr '\n' ' ')" | tee -a $summary; }
run 1024 r1r        ./jobs/q.sh 1024 r1r bash jobs/r1r.sh
run 1536 r2b        ./jobs/q.sh 1536 r2b bash jobs/r2.sh
run 1536 r3-b93fcfd env C=b93fcfd ./jobs/q.sh 1536 r3-b93fcfd bash jobs/r3.sh
run 1536 r3-eeffcc9 env C=eeffcc9 ./jobs/q.sh 1536 r3-eeffcc9 bash jobs/r3.sh
echo "resume finished $(date -u +%FT%TZ)" >> $summary; cat $summary
