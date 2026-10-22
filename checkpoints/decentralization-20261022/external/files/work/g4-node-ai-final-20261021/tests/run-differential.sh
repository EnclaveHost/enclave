#!/usr/bin/env bash
# usage: run-differential.sh <list> <mirror>...   ONE FILE AT A TIME (180 s bound each); a test that passes on the live
# mirror and fails on the composed mirror is a regression
set -uo pipefail
P=/home/steven/Documents/Codex/2026-10-18/wo/work/node-hold-package-20261021; L=$1; shift
for m in "$@"; do
  echo "######## $m"
  while read -r t; do
    [ -z "$t" ] && continue
    r=$(cd $P/$m && timeout 180 node --test --test-concurrency=1 --test-reporter=tap test/$t 2>&1); rc=$?
    echo "$t rc=$rc pass=$(grep -c '^ok ' <<<"$r") fail=$(grep -c '^not ok ' <<<"$r") $(grep '^not ok ' <<<"$r" | head -5 | tr '\n' '|')"
  done < $L
done
