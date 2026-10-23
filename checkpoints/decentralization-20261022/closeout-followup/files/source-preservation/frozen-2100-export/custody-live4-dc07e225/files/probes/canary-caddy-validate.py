"""Validate a standalone canary snippet with the control VM's installed Caddy; no serving/reload/config edit."""
import pathlib,subprocess,json,datetime,hashlib
p=pathlib.Path('work/custody-v2-ingress-forwarder-20261023/examples/Caddyfile.canary-snippet')
snippet=p.read_text().replace('<R>','18902')
config='http://127.0.0.1:18903 {\n'+snippet+'\nhandle {\n respond "Not found" 404\n}\n}\n'
cmd=['ssh','-p32423','-o','BatchMode=yes','-o','ConnectTimeout=10','-o','UserKnownHostsFile=/home/steven/Documents/Codex/2026-10-18/wo/work/control-vm/known_hosts','-i','/home/steven/.ssh/minipc','controladmin@127.0.0.1','caddy adapt --config /dev/stdin --adapter caddyfile --validate']
r=subprocess.run(cmd,input=config,text=True,capture_output=True,timeout=35)
result={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'scope':'standalone syntax/provisioning validation only; no listener, live config write or reload','snippetSha256':hashlib.sha256(p.read_bytes()).hexdigest(),'inputSha256':hashlib.sha256(config.encode()).hexdigest(),'exit':r.returncode,'diagnostics':r.stderr[-2000:]}
if r.returncode==0:
 d=json.loads(r.stdout);result['adaptedSha256']=hashlib.sha256(r.stdout.encode()).hexdigest();result['servers']=list(d.get('apps',{}).get('http',{}).get('servers',{}))
pathlib.Path('work/custody-v2-live-20261023/evidence/canary-caddy-validate.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result));raise SystemExit(r.returncode)
