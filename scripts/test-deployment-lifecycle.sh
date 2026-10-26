#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
# Invoke through the workspace resource queue when one is configured.
node --test --test-concurrency=1 test/deployment-lifecycle-policy.test.mjs test/deployment-lifecycle-journal.test.mjs test/deployment-lifecycle-runner.test.mjs test/deployment-generation-certificate.test.mjs test/deployment-lifecycle-boundary.test.mjs test/deployment-isolation-runtime.test.mjs test/lifecycle-finality-bridge.test.mjs
node test/deployment-journal-native.mjs
export FOUNDRY_SRC=test/lifecycle/forge/empty
export FOUNDRY_TEST=test/lifecycle/forge/test
export FOUNDRY_OUT=contracts/foundry/out/lifecycle
export FOUNDRY_CACHE_PATH=contracts/foundry/cache/lifecycle
export FOUNDRY_OPTIMIZER_RUNS=1
export FOUNDRY_EVM_VERSION=prague
forge test --threads 1 --match-contract LifecycleTest -vv
