from pathlib import Path
import shutil,tempfile,subprocess
root=Path(__file__).resolve().parents[1]
mutants=[
 ('authority',"authority?.outcome==='pass'&&authority.evidence?.resolves?.['host.accepted']?.ok===true","true"),
 ('reserve',"snapshot.memAvailableMiB>=LIMITS.floorMiB+LIMITS.memoryMax/MiB+LIMITS.recipientMiB","true"),
 ('protected-services',"need(hash(before.units)===hash(after.units),'protected service identity changed')","need(true,'protected service identity changed')"),
 ('environment',"need(hash(io.env(host.pid))===hash(env),'host inherited an unexpected environment')","need(true,'host inherited an unexpected environment')"),
 ('exact-qemu',"need(hash(args)===hash(expected),'VM arguments differ from exact reviewed host launch')","need(true,'VM arguments differ from exact reviewed host launch')"),
 ('cgroup-kernel-limit',"cg.memoryMax===String(LIMITS.memoryMax)&&cg.swapMax==='0'&&cg.tasksMax==='64'","true"),
 ('loopback',"hits[0].addr==='0100007F'","true"),
 ('stop-protected',"need(cg.pids.every(p=>!protectedPids.has(p)),'a protected process is inside the canary control group')","need(true,'a protected process is inside the canary control group')"),
 ('restart',"need(hash(load(observedFile))===hash(identity),'canary process restarted since first verified observation')","need(true,'canary process restarted since first verified observation')"),
]
for label,before,after in mutants:
 with tempfile.TemporaryDirectory(prefix='custody-runtime-mutant-') as t:
  d=Path(t);shutil.copytree(root/'driver',d/'driver');(d/'test').mkdir();shutil.copy2(root/'test/launch-runtime.test.mjs',d/'test/launch-runtime.test.mjs')
  p=d/'driver/launch-runtime.mjs';s=p.read_text();assert s.count(before)==1,(label,s.count(before));p.write_text(s.replace(before,after))
  r=subprocess.run(['node','--test','test/launch-runtime.test.mjs'],cwd=d,capture_output=True,text=True,timeout=20)
  assert r.returncode and 'ERR_ASSERTION' in r.stdout and 'ERR_MODULE_NOT_FOUND' not in r.stdout and 'SyntaxError' not in r.stdout,label+': survived or invalid failure\n'+r.stdout[-2000:]
  print(label+': detected',flush=True)
print(str(len(mutants))+'/'+str(len(mutants))+' broken runtime guards detected; fake systemd/process fixtures only')
