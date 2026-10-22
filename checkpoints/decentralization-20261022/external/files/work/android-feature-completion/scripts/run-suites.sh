#!/bin/bash
# Runs named node test files one suite at a time; each suite's TAP goes to logs/<name>.log; exit = 1 if ANY suite failed.
# usage: run-suites.sh <name> <file>... [-- <name> <file>...]
set -uo pipefail
H=/home/steven/Documents/Codex/2026-10-18/wo/work/android-feature-completion; cd $H/tree
overall=0; name=""; files=()
flush() { [ -z "$name" ] && return; node --test --test-concurrency=1 "${files[@]}" > $H/logs/$name.log 2>&1; rc=$?
  echo "$name: exit=$rc $(grep -E '^# (tests|pass|fail|skipped)' $H/logs/$name.log | tr '\n' ' ')"; [ $rc -ne 0 ] && overall=1; name=""; files=(); }
for x in "$@"; do if [ "$x" = "--" ]; then flush; elif [ -z "$name" ]; then name=$x; else files+=("$x"); fi; done; flush
exit $overall
