#!/bin/bash
set -euo pipefail
P=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025
cd "$P"
test "$(sha256sum journal-recovery-stage/r1/SHA256SUMS | cut -d ' ' -f1)" = 342ca52586e22f61a9d63bb1d2e6ec84cb0b6e4f2adde016ba4293862ec3c5a8
unshare -Urn bash journal-recovery-stage/r1/jobs/tests.sh
python3 -I -B journal-recovery-stage/r1/jbd2_inventory.py --journal "$P/logs/base-journal-copy-1626/journal-8.bin" --targets "$P/logs/base-journal-copy-1626/targets.json" --out "$P/logs/base-journal-copy-1626/inventory-r1.json"
