#!/usr/bin/env bash
set -euo pipefail
ROOT=/home/steven/Documents/Codex/2026-10-18/wo
cd "$ROOT/work/enclave"
node --test test/site-built-in-profile.test.mjs
node scripts/build-site.mjs
python3 "$ROOT/work/ci-explicit-targets/test/setup.py"
