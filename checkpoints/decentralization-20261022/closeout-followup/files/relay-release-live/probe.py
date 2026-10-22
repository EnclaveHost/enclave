import subprocess,json,datetime,concurrent.futures
from pathlib import Path
from urllib.parse import urlsplit
d=json.loads(Path('/home/steven/Projects/enclave/metal/config.json').read_text())
print(json.dumps({k:d.get(k) for k in ('name','publicUrl','relayUrl','hostfwd','dist')},indent=2))
ids=['0x7ae476a3a1e4b0b144248075ff6656a0a10c3ae4cea8b6e4ad2b59dd8989ce33','0x59f1273d3633117fb1a5314f627ed1e6977cf901336d3c24f6e86e45d9ac778c']
urls=['https://api.enclave.host/v1/secrets/release-status?id='+i for i in ids]
def one(u):
 p=subprocess.run(['curl','-sS','--connect-timeout','8','--max-time','15','-w','\n%{http_code}\n%{remote_ip}',u],capture_output=True,text=True)
 parts=p.stdout.rsplit('\n',2); body=parts[0]
 try:
  obj=json.loads(body);body={k:obj[k] for k in ('id','listed','error','reason','message') if k in obj}
 except Exception:body=body[:150]
 return {'url':u,'exit':p.returncode,'body':body,'http':parts[1] if len(parts)>1 else None,'remote':parts[2] if len(parts)>2 else None,'error':p.stderr[:300]}
with concurrent.futures.ThreadPoolExecutor(max_workers=2) as e:r=list(e.map(one,urls))
out={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'results':r}
Path(__file__).with_name('public-probe.json').write_text(json.dumps(out,indent=2)+'\n');print(json.dumps(out,indent=2))
