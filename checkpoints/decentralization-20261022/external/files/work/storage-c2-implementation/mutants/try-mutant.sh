#!/bin/bash
# try-mutant.sh <mutant>: run one C2 mutant through the shared queue; bounded retries 30 s apart while it is not
# started (exit 98); prints the mutant's failing tests and result
cd "$(dirname "$0")/.." || exit 2
for a in $(seq 1 16); do
  python3 ../claude-test-queue.py --mib 1024 --log mutants/out/$1.guard.log -- ./mutants/run-mutant.sh "$1" > mutants/out/$1.queue.out 2>&1
  rc=$?; [ $rc -ne 98 ] && break; sleep 30
done
echo "attempts=$a queue=$rc"; grep -E "FAILED$|^test result|cargo exit|applied|^error" mutants/out/$1.queue.out
