#!/bin/bash
set -euo pipefail
cd /home/steven/Documents/Codex/2026-10-18/wo
sshargs=(-p 32422 -o BatchMode=yes -o ConnectTimeout=10 -o UserKnownHostsFile=work/storage-vm/known_hosts -i /home/steven/.ssh/minipc storageadmin@127.0.0.1)
timeout 150 ssh "${sshargs[@]}" 'sudo systemctl start enclave-indexd && sleep 10 && systemctl show enclave-indexd -p ActiveState -p SubState -p NRestarts --no-pager'
timeout 330 ssh "${sshargs[@]}" 'sudo bash -s' < work/resume-after-checkpoint-20261022/production-migration-closeout/vm-state.sh > work/resume-after-checkpoint-20261022/production-run/pg-init-resumed-state.out
cat work/resume-after-checkpoint-20261022/production-run/pg-init-resumed-state.out
