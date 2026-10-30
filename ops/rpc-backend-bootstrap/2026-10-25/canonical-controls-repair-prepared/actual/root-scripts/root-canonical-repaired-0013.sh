#!/bin/bash
set -euo pipefail
cd /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025
test "$(cat logs/root-canonical-mutants-0006.rc)" = 1
test "$(cat logs/root-canonical-native-build-tests-0000.rc)" = 0
(cd verifier-canonical-controls-repair && sha256sum -c --quiet SHA256SUMS)
python3 verifier-canonical-controls-repair/jobs/make-repaired-mutants.py --check verifier-canonical-stage/jobs/canonical-mutants.sh verifier-canonical-controls-repair/jobs/canonical-mutants-repaired.sh
bash jobs/q-exit-status.sh root-canonical-repair-parser-0013 512 python3 -I verifier-canonical-controls-repair/tests/test_check_cargo_mutant.py
bash jobs/q-exit-status.sh root-canonical-repaired-mutants-0013 2560 unshare -rn env CANONICAL_CACHE_FROM=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/verifier-canonical-stage/run/tests-20261025T234358Z bash verifier-canonical-controls-repair/jobs/canonical-mutants-repaired.sh
