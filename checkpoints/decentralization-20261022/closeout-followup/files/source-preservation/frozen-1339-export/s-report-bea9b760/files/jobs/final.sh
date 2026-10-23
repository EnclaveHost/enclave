#!/usr/bin/env bash
# final evidence on the committed tree: key scan of the new commit, package rebuild + comparison with F, then the suites
set -uo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
cd "$HERE/repo"; echo "== scan 14d1e4954..HEAD"; python3 .githooks/scan-crypto-keys.py --range 14d1e4954..HEAD; echo "scan rc=$?"
exec bash "$HERE/jobs/build-and-test.sh" "$@"
