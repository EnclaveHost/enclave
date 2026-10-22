#!/bin/bash
set -uo pipefail; cd "$(dirname "$0")/.."; rc=0
node inputs/test-edit.mjs > test-edit.out 2>&1 || rc=1
NO_ORPHAN_STOP=1 python3 tools/challenge-test.py -v > challenge-test.out 2>&1 || rc=1
tail -1 test-edit.out; grep -E "^Ran|^OK|FAILED|NEGATIVE" challenge-test.out; echo "RC=$rc"; exit $rc
