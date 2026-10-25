#!/bin/bash
# The new startup regressions against the OLD launcher 8b1ece11 (staged copy): they must FAIL there.
G="$(cd "$(dirname "$0")/.." && pwd)"
T=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/source/ops/rpc-backend-bootstrap/2026-10-25/nvme-migration
sha256sum "$G/tmp/old-provision_vm-8b1ece11.py"
cd "$T" && TEST_TMP="$G/tmp" GUARD_REAL_QEMU=1 PROVISION_VM_LAUNCHER="$G/tmp/old-provision_vm-8b1ece11.py" timeout 400 python3 -u -m unittest test_guard_startup 2>&1
