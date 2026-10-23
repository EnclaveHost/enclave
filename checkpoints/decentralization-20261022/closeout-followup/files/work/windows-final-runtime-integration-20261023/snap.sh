#!/usr/bin/env bash
# One read-only snapshot of the pinned Safe/passkey code (two public RPCs, one block, pins enforced); the only network read.
set -euo pipefail
cd /home/steven/Documents/Codex/2026-10-18/wo/work/windows-final-runtime-integration-20261023/candidate
timeout -k 5 180 node scripts/test-fixtures/snapshot-safe-passkey-code.mjs
sha256sum test/fixtures/base-code/safe-passkey-code-base.json; wc -c test/fixtures/base-code/safe-passkey-code-base.json
