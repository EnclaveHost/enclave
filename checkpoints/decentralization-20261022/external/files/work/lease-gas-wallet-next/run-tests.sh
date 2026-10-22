#!/usr/bin/env bash
# All suites of this candidate, each through the coordinator's queue (98 = not started, retried by q.sh):
#   root's 40 tests on the candidate copies (512), pure unit tests (256), anvil stages + servers (768).
cd "$(dirname "$0")"
./q.sh 512 final-root node --test --test-concurrency=1 request.test.mjs verify-reserve.test.mjs handoff-server.test.mjs
./q.sh 512 final-unit node --test --test-concurrency=1 test/unit.test.mjs
./q.sh 768 final-anvil node --test --test-concurrency=1 test/anvil.test.mjs
