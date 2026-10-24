from pathlib import Path
import shutil,tempfile,subprocess
root=Path(__file__).resolve().parents[1]
cases=[
 ('generation-absence','!io.generationAlive(observed.host)&&!io.generationAlive(observed.vm)','true'),
 ('group-absence','io.groupProcesses(group).length===0','true'),
 ('port-absence',"!io.listeners().some(l=>[rec.ports.host,rec.ports.management].includes(l.port))",'true'),
 ('replacement-unit',"!u.InvocationID||u.InvocationID===started.invocation",'true'),
 ('sealed-private-mode','(before.mode&511n)===384n','true'),
 ('sealed-hardlink','before.nlink===1n','true'),
 ('sealed-stability','hash(sealedStateMetadata(bundle))===hash(sealed)','true'),
 ('later-recipient-runtime',"sameProtected(after,end);\n need(hash(after.qemus)===hash(end.qemus),'VM census changed during observation');",'void 0;'),
]
for name,old,new in cases:
 with tempfile.TemporaryDirectory(prefix='custody-stopped-mut-') as tmp:
  d=Path(tmp);shutil.copytree(root/'driver',d/'driver');(d/'test').mkdir();shutil.copyfile(root/'test/launch-runtime.test.mjs',d/'test/launch-runtime.test.mjs')
  p=d/'driver/launch-runtime.mjs';s=p.read_text();assert s.count(old)==1,(name,s.count(old));p.write_text(s.replace(old,new))
  r=subprocess.run(['node','--test','--test-force-exit','test/launch-runtime.test.mjs'],cwd=d,capture_output=True,text=True,timeout=25)
  assert r.returncode==1 and 'ERR_ASSERTION' in r.stdout and 'ERR_MODULE_NOT_FOUND' not in r.stdout and 'SyntaxError' not in r.stdout,(name,r.returncode,r.stdout[-1500:])
  print(name+': detected',flush=True)
print('8/8 stopped-state and recipient-preservation mutations detected; synthetic systemd/VM fixtures only')
