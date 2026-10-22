import concurrent.futures,datetime,json,subprocess
from pathlib import Path
root=Path('/home/steven/Documents/Codex/2026-10-18/wo')
replicas=json.loads((root/'outputs/route-dns-replicas.json').read_text())['replicas']
name='7ae476a3.app.enclave.host'
def verify(replica):
 answers=subprocess.check_output(['dig','@'+replica['address'],name,'A','+short','+time=3','+tries=1'],text=True,timeout=5).splitlines()
 addresses=[a for a in answers if a and all(c in '0123456789.' for c in a)]
 assert addresses and '62.238.4.214' not in addresses
 rows=[]
 for address in addresses:
  raw=subprocess.check_output(['curl','--fail','--silent','--show-error','--connect-timeout','8','--max-time','35','--resolve',name+':443:'+address,'https://'+name+'/api/status'],text=True,timeout=40)
  status=json.loads(raw);assert status['state']=='ready' and status['files']==1239 and not status.get('missing')
  rows.append({'address':address,'tlsVerified':True,'state':status['state'],'files':status['files'],'rootCid':status['rootCid']})
 return {'dnsReplica':replica['host'],'dnsAddress':replica['address'],'guestChecks':rows}
with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:rows=list(pool.map(verify,replicas))
report={'verifiedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'name':name,'replicas':rows,'limitation':'Guest HTTPS with standard certificate verification via direct DNS replica answers. Certificate renewal and parent DNS delegation remain unchanged.'}
(root/'outputs/route-dns-guest-tls.json').write_text(json.dumps(report,indent=2)+'\n')
print(json.dumps(report))
