#!/bin/bash
# Root-run under shared guard (512 MiB), in unshare -Urn. No build or live RPC.
set -euo pipefail
cd /home/steven/Documents/Codex/2026-10-23/it/work/signed-payload-capture-stage/r1
sha256sum -c --quiet SHA256SUMS
python - <<'CHECK_INPUTS'
import hashlib, json
from pathlib import Path
for name, expected in json.loads(Path('INPUTS.json').read_text())['sourceInputs'].items():
    actual = hashlib.sha256(Path(name).read_bytes()).hexdigest()
    if actual != expected:
        raise SystemExit('source input changed: ' + name)
CHECK_INPUTS
export CANDIDATE_BINARY=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/derivation-lease-coverage-stage/build/deps-43698236e9186750/target/debug/examples/signed_payload_candidate
exec env -u NODE_TEST_CONTEXT node --test capture.test.mjs
