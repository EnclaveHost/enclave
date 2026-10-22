#!/bin/bash
set -euo pipefail
export PWSH="$(cd "$(dirname "$0")/.." && pwd)/node-hold-package-20261021/tools/pwsh/pwsh"
cd "$(dirname "$0")/tree"
timeout 150 node --test --test-concurrency=1 test/windows-node-lease-readiness.test.mjs > ../readiness.out 2>&1
cat ../readiness.out
