from pathlib import Path
import subprocess,hashlib,os,json
p=Path(__file__).resolve().parent;os.sched_setaffinity(0,{min(os.sched_getaffinity(0))})
a=p/'adapter-generation-r2';i=p/'adapter-generation/schema3-adapter.mjs'
assert hashlib.sha256(i.read_bytes()).hexdigest()=='07d02fca0fff2b4b59f7680ac0425c65b779aa61e13ae2b7205b7af4ee4443b2'
with (a/'generator.json').open('x') as f, (a/'stderr.txt').open('x') as err:
 r=subprocess.run(['node',str(p/'author-snapshot/src/tools/generate-lifecycle-host-registry-adapter-candidate.mjs'),str(i),str(a/'deployment-chain-adapter.mjs')],stdout=f,stderr=err,timeout=25)
assert r.returncode==0,'generator refused; inspect retained stderr'
subprocess.run(['node','--check',str(a/'deployment-chain-adapter.mjs')],check=True,timeout=10)
(a/'pins.json').write_text(json.dumps({x.name:hashlib.sha256(x.read_bytes()).hexdigest() for x in a.iterdir() if x.is_file()},indent=2)+'\n')
