"""Bounded public status probes plus sanitized host evidence after cutover."""
from pathlib import Path
import datetime, json, subprocess, time, urllib.request
b = Path(__file__).resolve().parent
receipt = json.loads((b/'deployment-result-r2.json').read_text())
ids = json.loads((b.parent/'queued-funding-review/summary.json').read_text())['ids']
rows = []
for i in ids:
 start = time.monotonic()
 try:
  with urllib.request.urlopen('https://api.enclave.host/v1/secrets/release-status?id='+i, timeout=6) as r:
   v=json.load(r)
   rows.append({'id':i,'http':r.status,'listed':v.get('listed'),'exactId':v.get('id')==i,'ms':round((time.monotonic()-start)*1000)})
 except Exception as e:
  rows.append({'id':i,'error':type(e).__name__,'ms':round((time.monotonic()-start)*1000)})
 time.sleep(.15)
j=subprocess.check_output(['journalctl','--user','-u','enclave-metal.service','--since',receipt['at'],'--no-pager'],text=True)
counts={i:{'releaseTimeout':0,'unaffordable':0,'rpcQuorum':0} for i in ids}
for line in j.splitlines():
 for i in ids:
  if i in line:
   for key,pattern in [('releaseTimeout','release list could not be read'),('unaffordable','Unaffordable'),('rpcQuorum','RPC quorum')]:
    if pattern in line:counts[i][key]+=1
out={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'since':receipt['at'],'publicReleaseStatuses':rows,'hostErrorsSinceDeployment':counts}
(b/'postdeploy-verification.json').write_text(json.dumps(out,indent=2)+'\n')
print(json.dumps(out,indent=2))
assert all(x.get('http')==200 and x.get('listed') is True and x.get('exactId') for x in rows)
