from pathlib import Path
import subprocess,json,datetime,concurrent.futures
b=Path(__file__).resolve().parent
id='0xa69dcbbae66ac6ca71784d56209b1039142480ec97e0c8a3fd9cc658d969ed77'
ips=['134.209.248.172','134.199.235.187','146.190.246.39','165.245.191.129']
def one(ip):
 p=subprocess.run(['curl','-sS','--max-time','12','--connect-timeout','5','--resolve','api.enclave.host:443:'+ip,'-w','\n%{http_code}\n%{time_total}','https://api.enclave.host/v1/secrets/release-status?id='+id],capture_output=True,text=True,timeout=15)
 v=p.stdout.rsplit('\n',2)
 try:raw=json.loads(v[0]);body={k:raw[k] for k in ('id','listed','error') if k in raw}
 except Exception:body=None
 return {'ip':ip,'http':v[-2] if len(v)==3 else None,'seconds':v[-1] if len(v)==3 else None,'exit':p.returncode,'body':body,'error':p.stderr[:160]}
with concurrent.futures.ThreadPoolExecutor(max_workers=2) as e:rows=list(e.map(one,ips))
o={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'id':id,'results':rows};(b/'ingress-probe.json').write_text(json.dumps(o,indent=2)+'\n');print(json.dumps(o,indent=2))
