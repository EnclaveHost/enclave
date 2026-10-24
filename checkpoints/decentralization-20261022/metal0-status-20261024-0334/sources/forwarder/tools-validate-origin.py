"""Generate and validate only; no production listener, config write, DNS or reload."""
from pathlib import Path
import subprocess,json,hashlib,datetime
root=Path(__file__).resolve().parent
script="import fs from 'node:fs';import {compileOriginIngress} from './origin-config.mjs';const c=compileOriginIngress({endpoint:'https://custody-canary.enclave.host',listenPort:18973,upstreamPort:18971,tunnelPort:18972});fs.writeFileSync('examples/Caddyfile.canary-origin',c.caddy);fs.writeFileSync('examples/forwarder.origin.json',JSON.stringify(c.forwarder,null,2)+'\\n');console.log(c.caddy);"
caddy=subprocess.check_output(['node','--input-type=module','-e',script],cwd=root,text=True,timeout=10)
cmd=['ssh','-p32423','-o','BatchMode=yes','-o','ConnectTimeout=10','-o','StrictHostKeyChecking=yes','-o','UserKnownHostsFile=/home/steven/Documents/Codex/2026-10-18/wo/work/control-vm/known_hosts','-i','/home/steven/.ssh/minipc','controladmin@127.0.0.1','caddy adapt --config /dev/stdin --adapter caddyfile --validate']
r=subprocess.run(cmd,input=caddy,text=True,capture_output=True,timeout=35)
result={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'scope':'Dedicated-origin generated config syntax/provisioning validation only; no live route, listener, DNS, config write or reload','inputSha256':hashlib.sha256(caddy.encode()).hexdigest(),'exit':r.returncode,'diagnostics':r.stderr[-2000:]}
if r.returncode==0:
 d=json.loads(r.stdout);result['adaptedSha256']=hashlib.sha256(r.stdout.encode()).hexdigest();result['servers']=list(d.get('apps',{}).get('http',{}).get('servers',{}));(root/'evidence/origin-caddy-adapted.json').write_text(json.dumps(d,indent=2)+'\n')
(root/'evidence/origin-caddy-validate.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result));raise SystemExit(r.returncode)
