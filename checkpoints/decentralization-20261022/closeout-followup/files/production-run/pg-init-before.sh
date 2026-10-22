#!/bin/bash
set -euo pipefail
cd /home/steven/Documents/Codex/2026-10-18/wo
sshargs=(-p 32422 -o BatchMode=yes -o ConnectTimeout=10 -o UserKnownHostsFile=work/storage-vm/known_hosts -i /home/steven/.ssh/minipc storageadmin@127.0.0.1)
timeout 260 ssh "${sshargs[@]}" 'sudo systemctl stop enclave-indexd && systemctl show enclave-indexd -p ActiveState -p SubState --no-pager && if pgrep -u enclave-indexd -x indexd; then exit 1; else echo no-writer; fi' > work/resume-after-checkpoint-20261022/production-run/pg-init-stop-indexd.out
timeout 330 ssh "${sshargs[@]}" 'sudo bash -s' < work/resume-after-checkpoint-20261022/postgres-init-stage/pg-init-probe.sh > work/resume-after-checkpoint-20261022/production-run/pg-init-before.out
python3 - <<'PY'
from pathlib import Path
p=Path('work/resume-after-checkpoint-20261022/production-run/pg-init-before.out');d=dict(l.split('=',1) for l in p.read_text().splitlines() if '=' in l)
for k,v in {'container.running':'yes','pid1.comm':'postgres','postmaster.pid':'1','pg.otherClientSessions':'0','db.version':'26','digest.rc':'0','probe.complete':'yes','indexdUnit.ActiveState':'inactive','unit.sha256':'e0a45f510d35181c02800f08a65d1b6da308dbc236ff4b495c11d9ba7d280012'}.items():
 assert d.get(k)==v,(k,d.get(k),v)
print('PASS: indexd quiesced; PostgreSQL identity and metadata captured')
PY
