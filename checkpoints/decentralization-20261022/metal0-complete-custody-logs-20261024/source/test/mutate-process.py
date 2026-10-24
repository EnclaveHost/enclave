from pathlib import Path
import shutil,tempfile,subprocess
root=Path(__file__).resolve().parents[1]
mutants=[
 ('host-exit','canary-process.mjs','finally{exit(71);}','finally{}'),
 ('spawn-error','canary-process.mjs',"child.once('error',ended);","child.once('error',()=>{});"),
 ('graceful-stop','canary-process.mjs','if(isStopping())return;','if(false)return;'),
 ('manual-restart','cli.mjs','if (step?.expectOutage || step?.expectRestart)','if (false)'),
 ('owned-group','launch-runtime.mjs',"need(cg.pids.every(p=>allowed.has(p)),'unexpected process in canary control group')","need(true,'unexpected process in canary control group')"),
 ('recipient-preservation','launch-runtime.mjs',"need(hash(snapshot.qemus)===hash(others),'VM census changed during stop, or a canary VM remains')","need(true,'VM census changed during stop, or a canary VM remains')"),
]
for name,file,old,new in mutants:
 with tempfile.TemporaryDirectory(prefix='custody-process-mut-') as tmp:
  d=Path(tmp);shutil.copytree(root/'driver',d/'driver');(d/'test').mkdir()
  for p in ['canary-process.test.mjs','launch-runtime.test.mjs']:shutil.copyfile(root/'test'/p,d/'test'/p)
  p=d/'driver'/file;s=p.read_text();assert s.count(old)==1,(name,s.count(old));p.write_text(s.replace(old,new))
  r=subprocess.run(['node','--test','test/canary-process.test.mjs','test/launch-runtime.test.mjs'],cwd=d,capture_output=True,text=True,timeout=20)
  assert r.returncode==1 and 'ERR_ASSERTION' in r.stdout and 'ERR_MODULE_NOT_FOUND' not in r.stdout and 'SyntaxError' not in r.stdout,(name,r.returncode,r.stdout[-2000:],r.stderr)
  print(name+': detected',flush=True)
print('6/6 process and lifecycle recording mutations detected; real local child processes, synthetic systemd/VM fixtures; no production VM launched')
