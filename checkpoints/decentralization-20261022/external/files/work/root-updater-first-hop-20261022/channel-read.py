from pathlib import Path
import urllib.request,json,datetime,hashlib
p=Path(__file__).resolve().parent
with urllib.request.urlopen('https://get.enclave.host/windows/latest.json',timeout=15) as r:
 b=r.read(1048577);assert len(b)<=1048576;d=json.loads(b);x={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'url':r.geturl(),'http':r.status,'version':d.get('version'),'manifest':d.get('manifest'),'manifestSha256':d.get('manifestSha256'),'bodySha256':hashlib.sha256(b).hexdigest()}
with (p/'channel-read.json').open('x') as f:json.dump(x,f,indent=2);f.write('\n')
print(json.dumps(x));assert x['version']=='2026.10.12.47'
