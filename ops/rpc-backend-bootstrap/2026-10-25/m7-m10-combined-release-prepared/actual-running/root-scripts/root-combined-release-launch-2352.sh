#!/bin/bash
set -euo pipefail
cd /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025
X=$PWD/finality-stage/m7-m10-combined-release
O=/home/steven/Documents/Codex/2026-10-18/wo/outputs/rpc-production-final-20261025/m10-cli-child-supplement-1
SSH=(ssh -F /home/steven/.local/state/enclave-rpc-production/ssh_config enclave-rpc)
CC=$(sha256sum < "$O/cli-child-1.compound.json" | cut -c1-64)
CL=$(sha256sum < "$O/cli-child-1.launcher.json" | cut -c1-64)
CO=$(sha256sum < "$O/cli-child-1.out" | cut -c1-64)
CS=cf75de6890747d4a9224e84c8267628b6f2178348510687f2b4b2c2bec0e8175
MAN=9c9b2e83e18ba60c296df5549eb4baa85118429eac266dbbe800d51be73a1a75
bash "$X/host/transfer-release-stage.sh" "$MAN"
G=/srv/m10-guest-validation
"${SSH[@]}" "sudo sha256sum $G/receipts/cli-child-1.compound.json $G/receipts/cli-child-1.launcher.json $G/receipts/cli-child-1.out" > logs/root-combined-release-guest-pins-2352.out
python3 - "$CC" "$CL" "$CO" <<'PY'
import pathlib,sys
rows=pathlib.Path('logs/root-combined-release-guest-pins-2352.out').read_text().splitlines()
assert len(rows)==3 and [r.split()[0] for r in rows]==sys.argv[1:], 'guest receipts differ from the reviewed collected evidence'
PY
M=$("${SSH[@]}" "sudo python3 -I $G/stage-release-1/runner/supplement-manifest.py $G/supplement/cli-child-1/work/out")
printf '%s\n' "$M" >> logs/root-combined-release-guest-pins-2352.out
[ "$M" = "$CS 99" ]
python3 "$X/host/guest-release-watch.py" 1 "$MAN" 1 "$CC" "$CL" "$CO" "$CS" /home/steven/Documents/Codex/2026-10-18/wo/outputs/rpc-production-final-20261025/m7-m10-release-1
