from pathlib import Path
import subprocess,json,datetime
b=Path(__file__).resolve().parent
ssh=['ssh','-p','32423','-o','BatchMode=yes','-o','ConnectTimeout=8','-o','UserKnownHostsFile=work/control-vm/known_hosts','-i','/home/steven/.ssh/minipc','controladmin@127.0.0.1']
script="""import subprocess,pathlib,json,urllib.parse,time,concurrent.futures
pid=subprocess.check_output(['systemctl','show','enclave-api-relay','-p','MainPID','--value'],text=True).strip()
env=dict(x.split('=',1) for x in pathlib.Path('/proc/'+pid+'/environ').read_text().split(chr(0)) if '=' in x)
u=urllib.parse.urlsplit(env.get('BASE_RPC','https://mainnet.base.org'));print(json.dumps({'BASE_RPC':u.scheme+'://'+str(u.hostname),'pid':pid}))
ids=['0x7ae476a3a1e4b0b144248075ff6656a0a10c3ae4cea8b6e4ad2b59dd8989ce33','0x59f1273d3633117fb1a5314f627ed1e6977cf901336d3c24f6e86e45d9ac778c','0xa69dcbbae66ac6ca71784d56209b1039142480ec97e0c8a3fd9cc658d969ed77']
def one(id):
 t=time.monotonic();p=subprocess.run(['curl','-sS','--max-time','12','-w','\\n%{http_code}','http://127.0.0.1:8100/v1/secrets/release-status?id='+id],capture_output=True,text=True)
 try:d=json.loads(p.stdout.rsplit('\\n',1)[0]);body={k:d[k] for k in ('id','listed','error') if k in d}
 except Exception:body=None
 return {'id':id,'seconds':round(time.monotonic()-t,3),'code':p.stdout.rsplit('\\n',1)[-1],'exit':p.returncode,'body':body}
with concurrent.futures.ThreadPoolExecutor(max_workers=3) as e:print(json.dumps(list(e.map(one,ids))))
"""
p=subprocess.run(ssh+['sudo python3 -'],input=script,text=True,capture_output=True,timeout=30)
out={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'returncode':p.returncode,'results':[json.loads(x) for x in p.stdout.splitlines()],'error':p.stderr[:200]}
(b/'backend-probe.json').write_text(json.dumps(out,indent=2)+'\n');print(json.dumps(out,indent=2))
