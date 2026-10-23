#!/usr/bin/env bash
# J1: the Windows suites coupled to TLS (apptls/secrets/origin-request), M (host/agent/chain/manager/installer) and the
# rebuilt admission bundle; 76 files in 4 chunks, each file alone (run-suite.py). Network-runtime bundle rebuilt first.
set -uo pipefail
H=/home/steven/Documents/Codex/2026-10-18/wo/work/windows-final-runtime-integration-20261023; cd "$H/candidate"
PATH="$H/stubs:/usr/local/bin:/usr/bin:/bin" timeout -k 10 300 unshare -rn node relay/build-network.mjs >/dev/null && sha256sum relay/network-runtime.bundle.mjs || exit 9
cd "$H"; mapfile -t F < lists/win.txt; n=${#F[@]}; per=$(( (n + 3) / 4 )); rc=0
for i in 0 1 2 3; do ./run-suite.py j1-$i -- "${F[@]:$((i*per)):$per}" || rc=1; done
echo "[j1] files=$n rc=$rc"; exit $rc
