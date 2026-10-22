from pathlib import Path
import subprocess,json
base=Path(__file__).resolve().parent
ssh=['ssh','-p','32423','-o','BatchMode=yes','-o','ConnectTimeout=8','-o','UserKnownHostsFile=work/control-vm/known_hosts','-i','/home/steven/.ssh/minipc','controladmin@127.0.0.1']
script="""import pathlib,json,subprocess,urllib.parse
pid=subprocess.check_output(['systemctl','show','enclave-api-relay','-p','MainPID','--value'],text=True).strip()
env=dict(x.split('=',1) for x in pathlib.Path('/proc/'+pid+'/environ').read_text().split(chr(0)) if '=' in x)
allow=['SECRETS_ATTESTED_RELEASE','SECRETS_RELEASE_DEPLOYMENTS','SECRETS_RELEASE_APP_REFS','RPC_URL','RPC_URLS','BASE_RPC_URL','DEPLOYMENTS_ADDRESS','ADDRESS_BOOK','HOST_REGISTRY']
out={}
for k,v in env.items():
 if k in allow or ('RPC' in k and 'URL' in k):
  if 'RPC' in k:
   def safe(u):
    p=urllib.parse.urlsplit(u.strip());return p.scheme+'://'+str(p.hostname)+(':'+str(p.port) if p.port else '')+('/[path]' if p.path not in ('','/') else '')
   out[k]=[safe(u) for u in v.split(',')]
  else:out[k]=v
print(json.dumps(out))
"""
p=subprocess.run(ssh+['sudo python3 -'],input=script,text=True,capture_output=True,timeout=35);print(p.stdout);print(p.stderr[:200]);assert p.returncode==0
(base/'backend-public-settings.json').write_text(p.stdout)
for name in ['secrets-release.mjs','api-relay.js']:
 p=subprocess.run(ssh+['sudo cat /opt/nan-relay/'+name],capture_output=True,timeout=35);assert p.returncode==0,p.stderr
 (base/('installed-'+name)).write_bytes(p.stdout)
print('Saved two installed source modules, no configuration values outside whitelist.')
