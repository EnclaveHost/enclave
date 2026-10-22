#!/usr/bin/env bash
set -uo pipefail
B=/home/steven/Documents/Codex/2026-10-18/wo/work/cron-ingress-review-20261021/build
for v in deployed deployedfix; do
  cd "$B/$v" && timeout 300 node --test --test-concurrency=1 test/route-record.test.mjs test/public-directory.test.mjs test/route-partial-qualification.test.mjs test/route-partial-review.test.mjs > "$B/../logs/base-$v.out" 2>&1
  echo "$v rc=$? $(grep -E '^# (tests|pass|fail|todo)' "$B/../logs/base-$v.out" | tr '\n' ' ') FAILING: $(grep '^not ok' "$B/../logs/base-$v.out" | grep -v '# TODO' | sed 's/^not ok [0-9]* - //' | cut -c1-70 | tr '\n' '|')"
done
