#!/usr/bin/env bash
set -euo pipefail
cd /home/steven/Documents/Codex/2026-10-18/wo
bash -n work/enclave/scripts/publish-android-host.sh
python3 - <<'PY'
import ast, pathlib
ast.parse(pathlib.Path('work/heartbeat-readers-production/activate.py').read_text())
PY
node --test --test-concurrency=1 \
  work/app-lease-gas-root-journal-review/fix/writers.test.mjs \
  work/enclave/test/android-publish-targets.test.mjs \
  work/enclave/test/supervisor-image-closure.test.mjs \
  work/enclave/test/browser-profile.test.mjs \
  work/enclave/test/site-host-policy.test.mjs \
  work/enclave/test/site-independent-bundle.test.mjs
HOST_LIVENESS_RELAY_SCRIPT=../../heartbeat-readers-production/candidate/api-relay.js \
  node --test --test-concurrency=1 work/enclave/test/host-liveness.test.mjs
# A diagnostic of the frozen pre-fix writers, not a passing durability gate.
node work/app-lease-gas-root-journal-review/reproduce.mjs
