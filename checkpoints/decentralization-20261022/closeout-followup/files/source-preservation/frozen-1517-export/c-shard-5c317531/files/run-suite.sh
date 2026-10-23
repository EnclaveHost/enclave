#!/bin/bash
# run-suite.sh <label>: (copy of storage-clone-privacy-review/candidate/run-suite.sh) the whole sia-s3 test suite (ignored tests stay ignored; the fork cases are in run-cases.sh),
# ONE test per fresh process, sequentially, so peak memory is one test's. Each test's start is logged before it runs.
cd "$(dirname "$0")" || exit 2
label=$1
./cargo-step.sh test --no-run || exit 3
bin=$(grep -o "Executable unittests src/main.rs ([^)]*)" logs/cargo-last.out | tail -1 | sed 's/.*(\(.*\))/\1/')
sha256sum "$bin"
mkdir -p "logs/$label"
pass=0; fail=0; ign=0
for t in $("$bin" --list 2>/dev/null | grep ": test$" | sed 's/: test$//' | grep -v "^clone_privacy::\|clone_privacy_a_refused"); do
  echo "start $t" >> "logs/$label/progress.txt"
  timeout -k 5 900 "$bin" --exact "$t" --test-threads=1 > "logs/$label/$t.out" 2>&1
  rc=$?
  if grep -q "1 ignored" "logs/$label/$t.out"; then ign=$((ign+1)); r=ignored
  elif [ $rc -eq 0 ]; then pass=$((pass+1)); r=ok; else fail=$((fail+1)); r="FAILED rc=$rc"; fi
  echo "$t $r" | tee -a "logs/$label/progress.txt"
done
echo "suite: passed=$pass failed=$fail ignored=$ign"
[ $fail -eq 0 ]
