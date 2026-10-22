import json,socket,ipaddress,hashlib,concurrent.futures
from pathlib import Path
root=Path('private/sia-direct-recovery')
s=json.loads((root/'snapshot.json').read_text())
def resolve(h):
 out=[]
 for a in h['addresses']:
  if a['protocol']!='siamux':continue
  host,port=a['address'].rsplit(':',1);host=host.strip('[]')
  try:
   ips=sorted(set(r[4][0] for r in socket.getaddrinfo(host,int(port),socket.AF_INET,socket.SOCK_STREAM)))
   out.extend({'protocol':'siamux','address':f'{ip}:{int(port)}'} for ip in ips if ipaddress.ip_address(ip).is_global)
  except OSError:pass
 return {**h,'addresses':out}
with concurrent.futures.ThreadPoolExecutor(max_workers=16) as pool:s['hosts']=list(pool.map(resolve,s['hosts']))
ips=sorted(set(a['address'].rsplit(':',1)[0] for h in s['hosts'] for a in h['addresses']))
blocked=['62.238.4.214','134.199.235.187','146.190.246.39','165.245.191.129','134.209.248.172','127.0.0.1']
assert not set(ips)&set(blocked)
raw=json.dumps(s,separators=(',',':')).encode();(root/'snapshot-ip-pinned.json').write_bytes(raw);(root/'snapshot-ip-pinned.json').chmod(0o600)
release=json.loads(Path('../outputs/runtime-file-adapter/upload.json').read_text())
large='bafybeig7dtbv66j5kmv4xaygujynnxodxajdofmc43rhte7ezx5e6hkfty';data=Path('adapter-retained',large+'.bin').read_bytes()
samples=[{'cid':release['cid'],'sha256':release['sha256'],'bytes':release['bytes']},{'cid':large,'sha256':hashlib.sha256(data).hexdigest(),'bytes':len(data)}]
plan={'snapshotSha256':hashlib.sha256(raw).hexdigest(),'snapshotBytes':len(raw),'hostIPs':ips,'hostsWithEndpoints':sum(bool(h['addresses']) for h in s['hosts']),'blockedIPs':blocked,'samples':samples}
Path('sia-direct-recovery/test-plan.json').write_text(json.dumps(plan,indent=2)+'\n')
print(json.dumps({'snapshotBytes':len(raw),'hostsWithEndpoints':plan['hostsWithEndpoints'],'allowedIPCount':len(ips),'sampleSizes':[x['bytes'] for x in samples]}))
