"""Read only public operational metadata; never reads unit bodies, env, keys or journals."""
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import datetime, json, subprocess

HOSTS = ['us-west', 'eu-central', 'ap-southeast', 'ca-east']
SCRIPT = r'''import subprocess,json
def run(args):
 p=subprocess.run(args,capture_output=True,text=True,timeout=20)
 if p.returncode:raise RuntimeError('metadata command failed: '+args[0]+' exit '+str(p.returncode))
 return p.stdout
lines=run(['systemctl','list-units','--type=service','--state=running','--no-pager','--plain','--no-legend']).splitlines()
units=[x.split()[0] for x in lines if x.strip()]
target=[x for x in units if x.startswith(('enclave-','nan-','wg-quick@')) or x in ('caddy.service','dnsdist.service')]
relay=run(['systemctl','show','enclave-lease-relay.service','-p','ActiveState','-p','LoadState','-p','UnitFileState'])
print(json.dumps({'runningRelevantUnits':target,'relayUnit':dict(x.split('=',1) for x in relay.splitlines() if '=' in x)}))
'''
def collect(host):
 p=subprocess.run(['ssh','-o','BatchMode=yes','-o','ConnectTimeout=12',host,'python3','-'],input=SCRIPT,text=True,capture_output=True,timeout=45)
 if p.returncode:return {'host':host,'ok':False,'exit':p.returncode,'error':p.stderr[-300:]}
 return {'host':host,'ok':True,**json.loads(p.stdout)}
with ThreadPoolExecutor(max_workers=4) as pool: rows=list(pool.map(collect,HOSTS))
report={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'readOnly':True,'hosts':rows,
 'conclusion':'Running application service units on DigitalOcean remain migration work. This inventory does not stop anything or prove endpoint failover.',
 'scope':'Service names and state only. No unit files, environments, keys, databases or application logs read.'}
Path('outputs/decentralization-audit/digitalocean-service-closeout-inventory.json').write_text(json.dumps(report,indent=2)+'\n')
print(json.dumps(report,indent=2))
raise SystemExit(0 if all(x['ok'] for x in rows) else 1)
