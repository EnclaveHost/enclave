from pathlib import Path
import subprocess,os,hashlib,json
p=Path(__file__).resolve().parent
os.sched_setaffinity(0,{min(os.sched_getaffinity(0))})
u=p.parent; w=u.parent
r6=w/'lifecycle-chain-adapter-stage/r6/network/deployment-chain-adapter.mjs'
bundle=Path('/home/steven/Documents/Codex/2026-10-23/it/work/lifecycle-ledger-v3-r1/library-import-size-feedback/compiler/bundle.json')
a=p/'adapter-generation'
with (a/'schema3-generator.json').open('x') as f:
 subprocess.run(['node',str(u/'lifecycle-schema3-adapter-review-r1/src/tools/generate-lifecycle-schema3-adapter-candidate.mjs'),str(r6),str(bundle),str(a/'schema3-adapter.mjs'),'bed9c19652edce8ca6f337f691a9909c15763e6755ff237139b07f4d84f3260e'],check=True,stdout=f,timeout=25)
assert hashlib.sha256((a/'schema3-adapter.mjs').read_bytes()).hexdigest()=='07d02fca0fff2b4b59f7680ac0425c65b779aa61e13ae2b7205b7af4ee4443b2'
with (a/'host-registry-generator.json').open('x') as f:
 subprocess.run(['node',str(p/'author-snapshot/src/tools/generate-lifecycle-host-registry-adapter-candidate.mjs'),str(a/'schema3-adapter.mjs'),str(a/'deployment-chain-adapter.mjs')],check=True,stdout=f,timeout=25)
subprocess.run(['node','--check',str(a/'deployment-chain-adapter.mjs')],check=True,timeout=10)
(a/'pins.json').write_text(json.dumps({x.name:hashlib.sha256(x.read_bytes()).hexdigest() for x in a.iterdir() if x.is_file()},indent=2)+'\n')
