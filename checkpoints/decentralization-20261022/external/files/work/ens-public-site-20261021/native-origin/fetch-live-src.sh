#!/bin/bash
# READ-ONLY: copy the LIVE relay source file (code, no env/config) for an exact patch dry-run.
cd /home/steven/Documents/Codex/2026-10-18/wo
ssh -p32423 -o BatchMode=yes -o ConnectTimeout=10 -o UserKnownHostsFile=work/control-vm/known_hosts -i /home/steven/.ssh/minipc controladmin@127.0.0.1 'cat /opt/nan-relay/api-relay.js' > work/ens-public-site-20261021/native-origin/live/api-relay.js
sha256sum work/ens-public-site-20261021/native-origin/live/api-relay.js
