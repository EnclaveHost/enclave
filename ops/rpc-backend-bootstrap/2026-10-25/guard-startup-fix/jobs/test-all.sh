#!/bin/bash
# All guard/nvme-migration regressions against the fixed launcher (no VM; real QEMU only as -machine none).
# Run under: python3 work/claude-test-queue.py --mib 512 --log <guard> -- bash <this>
set -u
G="$(cd "$(dirname "$0")/.." && pwd)"
T=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/source/ops/rpc-backend-bootstrap/2026-10-25/nvme-migration
export TEST_TMP="$G/tmp" GUARD_REAL_QEMU=1
sha256sum "$T/../provision_vm.py"
rc=0
for t in ${SUITES:-test_guard_startup test_nvme_migration test_receipts test_real_qemu test_systemd_lifecycle}; do
  echo "## $t"; (cd "$T" && timeout 400 python3 -u -m unittest -v "$t") 2>&1; r=${PIPESTATUS[0]}; echo "## $t rc=$r"
  [ "$r" = 0 ] || rc=1
done
echo "## aggregate rc=$rc"; exit $rc
