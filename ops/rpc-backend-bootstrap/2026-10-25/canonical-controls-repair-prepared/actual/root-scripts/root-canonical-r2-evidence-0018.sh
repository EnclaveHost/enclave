#!/bin/bash
set -euo pipefail
cd /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025
(cd verifier-canonical-controls-repair/r2 && sha256sum -c --quiet SHA256SUMS)
test "$(cat logs/root-canonical-repaired-mutants-0013.rc)" = 1
bash jobs/q-exit-status.sh root-canonical-r2-parser-0018 512 python3 -I verifier-canonical-controls-repair/r2/tests/test_check_cargo_mutant_r2.py
bash jobs/q-exit-status.sh root-canonical-r2-reevaluate-0018 512 python3 -I verifier-canonical-controls-repair/r2/jobs/reevaluate_completed_run.py --run /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/verifier-canonical-controls-repair/run/mutants-20261026T001203Z --queue-log /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/logs/root-canonical-repaired-mutants-0013 --receipt /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/verifier-canonical-controls-repair/r2/logs/reevaluation-mutants-20261026T001203Z.json
