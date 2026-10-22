#!/usr/bin/env bash
# READ-ONLY control-VM metadata: node presence/version, default IPv4 route device, relay-ish unit names. No config/env.
cd /home/steven/Documents/Codex/2026-10-18/wo
timeout 40 ssh -p32423 -o BatchMode=yes -o ConnectTimeout=10 -o UserKnownHostsFile=work/control-vm/known_hosts -i /home/steven/.ssh/minipc controladmin@127.0.0.1 \
 'echo "node: $(command -v node) $(node -v 2>/dev/null)"; ip -4 route show default | head -2; ip -6 route show default | head -1; systemctl list-units --type=service --no-legend 2>/dev/null | awk "{print \$1, \$3, \$4}" | grep -iE "relay|enclave|platform|api" | head -10'
