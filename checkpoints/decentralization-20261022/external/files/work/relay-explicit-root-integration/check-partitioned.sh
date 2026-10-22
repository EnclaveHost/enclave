#!/usr/bin/env bash
# Run each independent fake-host scenario in a fresh Node process to bound retained heap.
# All assertions and source-integrity checks remain enabled.
set -euo pipefail
cd /home/steven/Documents/Codex/2026-10-18/wo/work/relay-explicit-root-integration
patterns=(
  '^missing configuration'
  '^malicious or malformed'
  '^a preflight refusal'
  '^an unreachable selected'
  '^the predictor check'
  '^an active prediction'
  '^the installed unit'
  '^source, copy, dependency'
  '^a successful deploy'
  '^only the selected role'
  '^a release that does not stay up'
  '^a connection lost'
)
for i in "${!patterns[@]}"; do
  log="evidence/partition-$i.log"
  TEST_NAME_PATTERN="${patterns[$i]}" ./run-tests.sh "$log" test/relay-deploy-targets.test.mjs
  grep -q '^# pass 1$' "$log"
  grep -q '^# fail 0$' "$log"
  printf 'PASS main scenario %s\n' "$i"
done
for layer in storage front; do
  LAYER_SET="$layer" ./run-tests.sh "evidence/$layer-closure.log" test/relay-deploy-closure.test.mjs
  LAYER_SET="$layer" TEST_NAME_PATTERN='^a successful deploy' ./run-tests.sh "evidence/$layer-ship.log" test/relay-deploy-targets.test.mjs
  grep -q '^# pass 1$' "evidence/$layer-ship.log"
  printf 'PASS %s composition\n' "$layer"
done
