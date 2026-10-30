#!/bin/bash
# compact-header-extraction-stage/r3 UNIT tests (prepared by Claude 1881/1892; NOT run by Claude). No mount/session/backup; tmp trees only. Root:
#   bash jobs/q-exit-status.sh che-r3-unit 256 unshare -Urn bash compact-header-extraction-stage/r3/jobs/tests.sh
# Expect "## PASS (16)".
set -uo pipefail
export PATH=/usr/bin:/bin LC_ALL=C
S=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/compact-header-extraction-stage/r3
(cd $S && sha256sum -c --quiet SHA256SUMS) || { echo "## REFUSED: stage != SHA256SUMS"; exit 9; }
O=$(mktemp -d /tmp/che1881-unit-XXXXXXXX) || exit 9
timeout -k 10 600 python3 -I -B -u -W always::ResourceWarning $S/tests/test_extract_unit.py > $O/stdout 2> $O/stderr; rc=$?
tail -40 $O/stderr
grc=1
[ $rc = 0 ] && grep -q '^Ran 25 tests' $O/stderr && [ "$(grep -v '^$' $O/stderr | tail -1)" = OK ] \
  && ! grep -qE 'ResourceWarning|skipped|Traceback' $O/stderr && grc=0
(cd $S && sha256sum -c --quiet SHA256SUMS) || { echo "## stage changed during the run"; grc=1; }
[ -z "$(find $S \( -name __pycache__ -o -name '*.pyc' \) -print)" ] || { echo "## bytecode written into the stage"; grc=1; }
[ $grc = 0 ] && echo "## PASS (25)" || echo "## FAIL (rc $rc)"
echo "## outputs $O"; exit $grc
