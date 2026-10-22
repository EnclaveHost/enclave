#!/bin/bash
set -euo pipefail
cd /home/steven/Documents/Codex/2026-10-18/wo
sshargs=(-p 32422 -o BatchMode=yes -o ConnectTimeout=10 -o UserKnownHostsFile=work/storage-vm/known_hosts -i /home/steven/.ssh/minipc storageadmin@127.0.0.1)
timeout 330 ssh "${sshargs[@]}" 'sudo bash -s' <<'REMOTE'
set -euo pipefail
vd=/root/pg-init-20261022T192040Z
unit=/etc/systemd/system/enclave-indexd-postgres.service
[ "$(sha256sum "$unit" | cut -c1-64)" = e0a45f510d35181c02800f08a65d1b6da308dbc236ff4b495c11d9ba7d280012 ]
[ "$(sha256sum "$vd/new.service" | cut -c1-64)" = 59b60ddd739d3ff5e27317faf794f4c25ce150acff38d2ec1a3de0322afdd183 ]
[ "$(systemctl show enclave-indexd -p ActiveState --value)" = inactive ]
if pgrep -u enclave-indexd -x indexd; then exit 1; fi
start=$(date -u '+%Y-%m-%d %H:%M:%S UTC')
systemctl stop enclave-indexd-postgres
[ "$(systemctl show enclave-indexd-postgres -p ActiveState --value)" = inactive ]
[ "$(systemctl show enclave-indexd-postgres -p Result --value)" = success ]
journalctl -u enclave-indexd-postgres --since "$start" -o cat --no-pager | grep -F 'database system is shut down'
for i in $(seq 1 30); do
 left=$(docker ps -a -q --filter 'name=^/enclave-indexd-postgres$')
 [ -z "$left" ] && break
 sleep 1
done
[ -z "$left" ]
install -m 0644 -o root -g root "$vd/new.service" "$unit"
systemctl daemon-reload
[ "$(sha256sum "$unit" | cut -c1-64)" = 59b60ddd739d3ff5e27317faf794f4c25ce150acff38d2ec1a3de0322afdd183 ]
[ "$(systemctl show enclave-indexd-postgres -p NeedDaemonReload --value)" = no ]
systemctl start enclave-indexd-postgres
echo 'candidate-installed; PostgreSQL started; indexd remains stopped for comparison'
REMOTE
timeout 330 ssh "${sshargs[@]}" 'sudo bash -s -- wait' < work/resume-after-checkpoint-20261022/postgres-init-stage/pg-init-probe.sh > work/resume-after-checkpoint-20261022/production-run/pg-init-after.out
python3 work/resume-after-checkpoint-20261022/postgres-init-stage/compare.py work/resume-after-checkpoint-20261022/production-run/pg-init-before.out work/resume-after-checkpoint-20261022/production-run/pg-init-after.out --expect init
