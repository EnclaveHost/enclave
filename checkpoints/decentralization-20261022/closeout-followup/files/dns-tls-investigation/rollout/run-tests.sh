#!/usr/bin/env bash
# offline: a private user+net namespace (loopback only), ssh/scp/sftp denial stubs first in PATH, bounded
set -uo pipefail
H=/home/steven/Documents/Codex/2026-10-18/wo/work/resume-after-checkpoint-20261022/dns-tls-investigation
cd "$H/rollout"; mkdir -p tmp
timeout -k 5 300 unshare -r -n sh -c 'ip link set lo up && PATH="'"$H"'/stubs:$PATH" && export PATH && for t in ssh scp sftp; do [ "$(command -v $t)" = "'"$H"'/stubs/$t" ] || exit 90; done && exec python3 -u test_two_file.py -v' 2>&1
rc=$?; rm -rf tmp/two-file-*; echo "[tests] exit=$rc"; exit $rc
