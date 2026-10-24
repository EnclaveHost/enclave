"""Read selected public metal runner configuration and HTTP capabilities; no credentials or state mutation."""
import json,pathlib,hashlib,urllib.request,datetime,subprocess
p=pathlib.Path('/home/steven/Projects/enclave/metal/config.json');d=json.loads(p.read_text())
public={k:d.get(k) for k in ['dist','mode','name','cpus','memMiB','publicUrl','wasmtimeBin']}
iso=d.get('isolation'); public['isolation']={k:(iso[k] if isinstance(iso[k],(str,int,bool)) else {'configured':True,'type':type(iso[k]).__name__}) for k in ['mode','guestd','root','enabled'] if k in iso} if isinstance(iso,dict) else (iso if isinstance(iso,(str,int,bool)) else None)
# Emit only types/names for paths that may carry a config object.
for k,v in list(public.items()):
 if isinstance(v,(dict,list)) and k!='isolation':public[k]={'configured':True,'type':type(v).__name__}
dist=pathlib.Path(public['dist']);mp=dist/'manifest.json';manifest=None
if mp.is_file():
 data=json.loads(mp.read_text());manifest={'path':str(mp),'sha256':hashlib.sha256(mp.read_bytes()).hexdigest(),'fields':sorted(data)}
 for k in ['commit','measurement','runtimeId','mode','transport','isolation']:
  if isinstance(data.get(k),(str,int,bool)):manifest[k]=data[k]
responses=[]
for suffix in ['/v1/health','/availability']:
 url='https://api.enclave.host/t/metal0'+suffix
 row={'url':url}
 try:
  with urllib.request.urlopen(url,timeout=10) as r:
   body=r.read(131073);row.update(httpStatus=r.status,bytes=len(body),sha256=hashlib.sha256(body).hexdigest())
   if len(body)>131072:raise ValueError('oversize public response')
   obj=json.loads(body);row['fields']=sorted(obj) if isinstance(obj,dict) else []
   if isinstance(obj,dict):
    for k in ['mode','isolation','capabilities','custody','custodyV2','version','status','runtimeId','measurement','fullService','claimEnabled','memMb','cpuAvailable','cpuTotal','ramGbFree','nodeRamGb','nodeVcpus','cpuShareFree','maxShare','secrets','teeCpu']:
     v=obj.get(k)
     if isinstance(v,(str,int,bool,list,dict)):row[k]=v
 except Exception as e:row['error']=str(e)[:180]
 responses.append(row)
out={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'readOnly':True,'publicConfiguration':public,'manifest':manifest,'http':responses,'limits':['Public configuration/HTTP metadata only; no secret keys, raw environment, sealed state or secret records read or emitted. No service or configuration changed.']}
pathlib.Path('work/custody-v2-live-20261023/evidence/recipient-runtime-capabilities.json').write_text(json.dumps(out,indent=2)+'\n');print(json.dumps(out))
