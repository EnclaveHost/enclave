#!/usr/bin/env bash
# READ-ONLY: from the control VM, a bare TCP connect (no SSH login, no data) to minipc's sshd at the default gateway, and
# the gateway itself. Nothing else.
cd /home/steven/Documents/Codex/2026-10-18/wo
timeout 40 ssh -p32423 -o BatchMode=yes -o ConnectTimeout=10 -o UserKnownHostsFile=work/control-vm/known_hosts -i /home/steven/.ssh/minipc controladmin@127.0.0.1 \
 'gw=$(ip -4 route show default | awk "/default/{print \$3; exit}"); echo "gateway $gw"; if timeout 4 bash -c "</dev/tcp/$gw/22" 2>/dev/null; then echo "tcp $gw:22 OPEN"; else echo "tcp $gw:22 CLOSED/FILTERED"; fi'
