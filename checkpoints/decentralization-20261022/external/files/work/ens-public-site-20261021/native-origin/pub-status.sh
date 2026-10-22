#!/bin/bash
# READ-ONLY, once: the publisher's public status (GET), whitelisted fields only.
curl -sS --max-time 20 -o /tmp/ps.$$ -w '%{http_code} %{ssl_verify_result}\n' https://d9798e4c.app.enclave.host/api/status
python3 - /tmp/ps.$$ <<'PY'
import json,sys
try: d=json.load(open(sys.argv[1]))
except Exception as e: print('non-json', open(sys.argv[1],'rb').read()[:120]); sys.exit()
keep=('authorityMode','configError','lastError','sequence','value','validUntil','publishedAt','mode','durableState','uptimeSecs')
print(json.dumps({**{k:d.get(k) for k in keep},'ipni':d.get('ipni'),'anchor':{k:(d.get('anchor') or {}).get(k) for k in ('seq','cid','block','lastError','rounds_ok','roundsOk')}},indent=1))
PY
rm -f /tmp/ps.$$
