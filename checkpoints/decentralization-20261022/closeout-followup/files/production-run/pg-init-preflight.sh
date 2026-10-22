#!/bin/bash
set -euo pipefail
cd /home/steven/Documents/Codex/2026-10-18/wo
ssh -p 32422 -o BatchMode=yes -o ConnectTimeout=10 -o UserKnownHostsFile=work/storage-vm/known_hosts -i /home/steven/.ssh/minipc storageadmin@127.0.0.1 'sudo bash -s' <<'REMOTE'
set -euo pipefail
sha256sum /etc/systemd/system/enclave-indexd-postgres.service
stat -c '%a %U:%G' /etc/systemd/system/enclave-indexd-postgres.service
systemctl show enclave-indexd-postgres -p DropInPaths -p ActiveState -p SubState --no-pager
docker info --format '{{.InitBinary}}'
docker version --format '{{range .Server.Components}}{{.Name}}={{.Version}} {{end}}'
timeout 60 docker run --rm --init --pull never --network none --entrypoint cat postgres@sha256:74935e72241653ca55e0414067e6d8763aceb8a810eb51b452253ec3dcfc4336 /proc/1/comm
REMOTE
