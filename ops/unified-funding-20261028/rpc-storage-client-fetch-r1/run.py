from pathlib import Path
import subprocess,json,hashlib,shlex,time
p=Path(__file__).resolve().parent;start=time.monotonic()
cmd=json.loads((p/'SSH.json').read_text())+[shlex.join(json.loads((p/'REMOTE.json').read_text()))]
with (p/'storage-client.tar').open('xb') as f,(p/'stderr.txt').open('xb') as e:r=subprocess.run(cmd,stdout=f,stderr=e,timeout=90)
assert r.returncode==0
f=p/'storage-client.tar';assert f.stat().st_size==9574400
with f.open('rb') as stream:h=hashlib.file_digest(stream,'sha256').hexdigest()
assert h=='64222d5433f24a6d32adf0a84031c1d844aaaca534bf162227657475f494ae9c'
(p/'RESULT.json').write_text(json.dumps({'exit':r.returncode,'bytes':f.stat().st_size,'sha256':h,'seconds':time.monotonic()-start,'publicArtifactOnly':True})+'\n')
