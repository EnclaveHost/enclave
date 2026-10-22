from pathlib import Path
import subprocess,hashlib,json
out=Path('work/admin-windows-restoration');out.mkdir(exist_ok=True);before=json.loads(Path('outputs/admin-control-audit/windows-before.json').read_text())
remote='minipc:C:/Program Files/Enclave/control/windows/node/'
for f in before['files']:
 name=f['file'];p=out/('before-'+name)
 r=subprocess.run(['scp','-q','-o','BatchMode=yes',remote+name,str(p)],capture_output=True,text=True,timeout=30)
 if r.returncode:raise RuntimeError(r.stderr[:200])
 assert hashlib.sha256(p.read_bytes()).hexdigest()==f['sha256'],'live bytes changed'
 if name=='host-admission.bundle.mjs':pbytes=Path('work/enclave/windows/node/'+name).read_bytes()
 else:
  s=p.read_text()
  changes={'host.mjs': [('if (!this.hostAdmission && v.yanked)','if (v.yanked)'),('refusal({deploymentId:d.id,appRef:d.appRef})','refusal({deploymentId:d.id,appRef:d.appRef,forPrivate:d.isPublic===false})')], 'chain.mjs':[('if (version && !hostWalletPolicy) {','if (version) {')]}
  for a,b in changes[name]:assert s.count(a)==1,(name,a);s=s.replace(a,b)
  pbytes=s.encode()
 (out/name).write_bytes(pbytes)
 f['afterSha256']=hashlib.sha256(pbytes).hexdigest()
(out/'manifest.json').write_text(json.dumps({'files':before['files'],'beforeVMs':before['vms'],'scope':'Only host admission modules; no manager/guest/installer/contract changes'},indent=2)+'\n')
print(json.dumps({'prepared':before['files']}))
