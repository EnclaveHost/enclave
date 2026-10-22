#!/bin/bash
# run-cases.sh <label>: builds the candidate's test binary once, then runs every clone_privacy case in its OWN fresh
# test process (a fork copies only the forking thread, so a case must not inherit threads of earlier cases), each
# with a bounded timeout (timeout signals the whole process group, the forked copy included). Prints one
# "case ... rc=N" line per case.
cd "$(dirname "$0")" || exit 2
label=$1
./cargo-step.sh test --no-run || exit 3
bin=$(grep -o "Executable unittests src/main.rs ([^)]*)" logs/cargo-last.out | tail -1 | sed 's/.*(\(.*\))/\1/')
[ -x "$bin" ] || { echo "no test binary"; exit 4; }
sha256sum "$bin"
mkdir -p "logs/$label"
fail=0
for t in $("$bin" --list 2>/dev/null | grep clone_privacy | sed 's/: test$//'); do
  timeout -k 5 300 "$bin" --exact "$t" --test-threads=1 --nocapture > "logs/$label/$t.out" 2>&1
  rc=$?
  echo "case $t rc=$rc"
  [ $rc -ne 0 ] && fail=1
done
exit $fail
