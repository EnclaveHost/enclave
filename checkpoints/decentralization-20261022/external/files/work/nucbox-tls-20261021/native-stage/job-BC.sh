#!/bin/bash
# Phase B: upload the reviewed files into the NEW staging dir only (fixed/, mut/ test+fake, the phase C text); then
# phase C (hash-pinned, parsed) runs --check and the tests natively with the manager's own node.exe. Nothing else.
set -uo pipefail
cd "$(dirname "$0")"
D=/C:/ProgramData/Enclave/hotfix/nucbox-stopfix-20261021
O="-q -o BatchMode=yes -o ConnectTimeout=15"
scp $O ../tree/windows/vbslike/manager/wmiserve-run.mjs ../tree/windows/vbslike/manager/wmiserve-run.test.mjs minipc:$D/fixed/ 2>/dev/null || exit 7
scp $O ../tree/windows/vbslike/manager/testdata/fake-wmiserve.mjs minipc:$D/fixed/testdata/ 2>/dev/null || exit 7
scp $O ../tree/windows/vbslike/manager/wmiserve-run.test.mjs minipc:$D/mut/ 2>/dev/null || exit 7
scp $O ../tree/windows/vbslike/manager/testdata/fake-wmiserve.mjs minipc:$D/mut/testdata/ 2>/dev/null || exit 7
scp $O C-test.ps1 minipc:$D/C-test.ps1.txt 2>/dev/null || exit 7
./run-ps.sh B-boot.ps1 C-out.json; rc=$?
scp $O "minipc:$D/results/*" results/ 2>/dev/null; ls results
exit $rc
