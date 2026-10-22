#!/bin/bash
# READ-ONLY recovery watch for cron 0x38f368d6 (root may run it through the queue): new VM console (cert/egress lines),
# network.log/node.log lines for the app, authoritative DNS and the public status through us-west. Changes nothing.
S=/home/steven/Documents/Codex/2026-10-18/wo/work/cron-startup-20261021/storage-network
bash $S/job-progress.sh >/dev/null 2>&1
python3 - <<PY
import json
for f in ('progress-partition','progress-net','progress-node'):
    v=list(json.load(open('$S/'+f+'.json')).values())[0]
    for l in (v.get('lines') or [])[-4:]: print(f, l[:200])
PY
dig +noall +comments +answer 38f368d6.app.enclave.host A @ns-us-west.enclave.host | grep -E "status|A\s"
curl -sS --max-time 30 --resolve 38f368d6.app.enclave.host:443:134.199.235.187 -w "\ncron via us-west: %{http_code} verify=%{ssl_verify_result}\n" https://38f368d6.app.enclave.host/ | tail -c 300
