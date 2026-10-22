#!/usr/bin/env bash
# The final serial verification of the candidate. Every command runs through run-guarded.sh; results go to logs/final-*.log
# and a one-line summary per command to logs/final-summary.txt.
set -u
here="$(cd "$(dirname "$0")" && pwd)"; S="$here/logs/final-summary.txt"; only="${1:-.}"
step() { local name="$1" dir="$2"; shift 2; [[ "$name" =~ $only ]] || return 0; : > "$here/logs/final-$name.log"; ( cd "$dir" && "$here/run-guarded.sh" "$here/logs/final-$name.log" "$@" > /dev/null 2>&1 ); local rc=$?
  if [ $rc -eq 98 ]; then echo "$name: NOT STARTED (queue 98)" | tee -a "$S"; return 0; fi
  local res; res=$(grep -E "^# (pass|fail) " "$here/logs/final-$name.log" | tail -2 | tr '\n' ' '); local peak; peak=$(grep -o "peakTreeRssMiB=[0-9]*" "$here/logs/final-$name.log" | tail -1)
  echo "$name: exit=$rc $res$peak" | tee -a "$S"; }
step durability "$here/tree" node --test --test-concurrency=1 test/cli-independent-signer-durability.test.mjs
step existing "$here/tree" node --test --test-concurrency=1 test/cli-independent-signer.test.mjs
step race-new "$here/tree" node --test --test-concurrency=1 test/cli-independent-signer-race.test.mjs
step race-old-negative-control "$here/tree" env SIGNER_TREE="$here/old" node --test --test-concurrency=1 test/cli-independent-signer-race.test.mjs
step cli-source-integration "$here/cli-tree" node --test --test-concurrency=1 test/cli-independent-signer-cli.test.mjs
step cli-source-reservation "$here/cli-tree" node --test --test-concurrency=1 test/cli-independent-signer-reservation-cli.test.mjs
step build-bundle "$here/cli-tree" node cli/build.mjs "$here/cli-tree/cli/dist/enclave.mjs"
step cli-bundle-integration "$here/cli-tree" env ENCLAVE_CLI_ENTRY="$here/cli-tree/cli/dist/enclave.mjs" node --test --test-concurrency=1 test/cli-independent-signer-cli.test.mjs
step cli-bundle-reservation "$here/cli-tree" env ENCLAVE_CLI_ENTRY="$here/cli-tree/cli/dist/enclave.mjs" node --test --test-concurrency=1 test/cli-independent-signer-reservation-cli.test.mjs
step cli-old-negative-control "$here/cli-tree-old" node --test --test-concurrency=1 --test-name-pattern="two CLI processes" test/cli-independent-signer-reservation-cli.test.mjs
[[ mutants =~ $only ]] && "$here/mutate.sh" | tee -a "$S"
