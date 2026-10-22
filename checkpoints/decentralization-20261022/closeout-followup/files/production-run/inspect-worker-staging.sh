#!/bin/bash
set -euo pipefail
cd /home/steven/Documents/Codex/2026-10-18/wo
ssh -p 32422 -o BatchMode=yes -o ConnectTimeout=10 -o UserKnownHostsFile=work/storage-vm/known_hosts -i /home/steven/.ssh/minipc storageadmin@127.0.0.1 'sudo bash -s' <<'REMOTE'
set -euo pipefail
d=/root/indexd-migration/20991231T000000Z-0badc0de
if [ -d "$d" ] && [ ! -L "$d" ]; then
 stat -c '%a %U:%G %n' "$d"
 find "$d" -maxdepth 1 -type f -printf '%f %s\n'
 sha256sum "$d"/*
fi
systemctl list-units --all 'enclave-indexd-migrate-*20991231*' --no-legend
systemctl show enclave-indexd -p ActiveState -p SubState -p NRestarts --no-pager
readlink /opt/enclave-indexd/releases/current
sha256sum /etc/systemd/system/enclave-indexd.service.d/20-fence-release.conf
REMOTE
