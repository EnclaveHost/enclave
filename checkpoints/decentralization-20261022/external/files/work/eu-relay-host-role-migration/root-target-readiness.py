#!/usr/bin/env python3
import json,subprocess,pathlib,hashlib,datetime,os

def cmd(args):
 r=subprocess.run(args,text=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=15)
 return {'exitCode':r.returncode,'stdout':r.stdout.strip()[:1600],'stderr':r.stderr.strip()[:300]}

paths=['/usr/bin/node','/opt/enclave/network/host-services/lease-relay-host.mjs','/opt/enclave/node_modules/viem','/etc/systemd/system/enclave-host-relay.service','/etc/enclave/host-relay.json','/etc/enclave/lease-gas-deployment.json','/var/lib/enclave-host-relay-migration']
metadata={}
for p in paths:
 q=pathlib.Path(p)
 try:
  st=q.lstat();metadata[p]={'exists':True,'mode':oct(st.st_mode & 0o777),'uid':st.st_uid,'size':st.st_size,'symlink':q.is_symlink()}
 except FileNotFoundError:metadata[p]={'exists':False}
 except PermissionError:metadata[p]={'access':'not readable; not inspected'}
r={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'mode':'read-only metadata; no key/env/DB/file-content inspection','host':cmd(['hostname']), 'node':cmd(['/usr/bin/node','--version']),'paths':metadata,'unit':cmd(['systemctl','show','enclave-host-relay.service','-p','LoadState','-p','ActiveState','-p','SubState','-p','UnitFileState']),'listener':cmd(['ss','-Hltn','sport = :8549']),'rootAvailable':cmd(['sudo','-n','true'])['exitCode']==0}
out=pathlib.Path(__file__).parent/'root-target-readiness.json';out.write_text(json.dumps(r,indent=2)+'\n');print(json.dumps(r))
