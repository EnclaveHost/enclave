import subprocess,json,datetime,concurrent.futures
from pathlib import Path
urls=['https://enclave.host/','https://enclavehost.eth/','https://59f1273d.app.enclave.host/healthz','https://7ae476a3.app.enclave.host/healthz','https://ef514ed3.app.enclave.host/healthz','https://9eb4e600.app.enclave.host/']
def probe(url):
 p=subprocess.run(['curl','--silent','--show-error','--max-time','15','--connect-timeout','8','--output','/dev/null','--write-out','%{http_code}\n%{remote_ip}\n%{ssl_verify_result}\n%{time_total}',url],capture_output=True,text=True)
 v=p.stdout.splitlines()
 return {'url':url,'exit':p.returncode,'httpStatus':v[0] if v else None,'remoteIp':v[1] if len(v)>1 else None,'tlsVerifyResult':v[2] if len(v)>2 else None,'seconds':v[3] if len(v)>3 else None,'error':p.stderr.strip()[:300]}
with concurrent.futures.ThreadPoolExecutor(max_workers=4) as e:results=list(e.map(probe,urls))
r={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'scope':'Read-only GET, this workstation system resolver and curl trust store; .eth failure here alone does not prove native-client outage; HTTP200 does not establish full app readiness','results':results}
out=Path(__file__).parent/'result.json';out.write_text(json.dumps(r,indent=2)+'\n')
print(json.dumps(r,indent=2))
