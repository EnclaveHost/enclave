#!/bin/bash
# Queue candidate admission tests, then the SAME candidate tests against the ORIGINAL queue (must fail on 1792 rules).
cd "$(dirname "$0")"
echo "## candidate"; python3 -u -m unittest -v test_queue_1792 2>&1; a=$?; echo "## candidate rc=$a"
echo "## negative control: Candidate1792 tests against the original queue (failures expected)"
QUEUE_UNDER_TEST="$PWD/original-claude-test-queue.py" python3 -u -m unittest -v test_queue_1792.Candidate1792 2>&1; b=$?; echo "## control rc=$b"
[ $a = 0 ] && [ $b != 0 ] && { echo "## aggregate rc=0"; exit 0; }; echo "## aggregate rc=1"; exit 1
