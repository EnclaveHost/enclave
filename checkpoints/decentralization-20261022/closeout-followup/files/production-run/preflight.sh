#!/bin/bash
set -euo pipefail
cd /home/steven/Documents/Codex/2026-10-18/wo
out=work/resume-after-checkpoint-20261022/production-run
sshargs=(-p 32422 -o BatchMode=yes -o ConnectTimeout=10 -o UserKnownHostsFile=work/storage-vm/known_hosts -i /home/steven/.ssh/minipc storageadmin@127.0.0.1)
timeout -k 10 330 ssh "${sshargs[@]}" 'sudo bash -s' < work/claude-resumed-20261022/control-package/storage-migration-r4/preflight/vm-preflight.sh > "$out/preflight.out"
python3 work/claude-resumed-20261022/control-package/storage-migration-r4/preflight/evaluate-preflight.py "$out/preflight.out" > "$out/preflight-evaluated.json"
timeout -k 10 330 ssh "${sshargs[@]}" 'sudo bash -s' < work/resume-after-checkpoint-20261022/production-migration-closeout/vm-state.sh > "$out/state.out"
cat "$out/preflight-evaluated.json"
cat "$out/state.out"
