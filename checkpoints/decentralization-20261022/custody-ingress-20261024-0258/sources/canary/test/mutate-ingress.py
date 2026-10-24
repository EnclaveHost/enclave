from pathlib import Path
import shutil,tempfile,subprocess
root=Path(__file__).resolve().parents[1]
mutants=[
 ('public-refusal',"r.method===m&&r.target===p&&r.status===404","true"),
 ('tls-verification',"rejectUnauthorized:true","rejectUnauthorized:false"),
 ('raw-target',"method,path:target,agent:false","method,path:new URL(target,'https://x').pathname,agent:false"),
 ('environment',"hash(io.env(pid))===hash(['PATH=/usr/bin:/bin'])","true"),
 ('loopback',"hits[0].addr==='0100007F'","true"),
 ('route-race',"control.routeSha256===controlAfter.routeSha256","true"),
 ('kernel-oom',"cg.events.oom==='0'&&cg.events.oom_kill==='0'","true"),
 ('fresh-remote',"result.at>=now()-30000","true"),
]
for label,before,after in mutants:
 with tempfile.TemporaryDirectory(prefix='custody-ingress-mutant-') as t:
  d=Path(t);shutil.copytree(root/'driver',d/'driver');(d/'test').mkdir();shutil.copy2(root/'test/launch-ingress.test.mjs',d/'test/launch-ingress.test.mjs')
  p=d/'driver/launch-ingress.mjs';s=p.read_text();assert s.count(before)==1,(label,s.count(before));p.write_text(s.replace(before,after))
  r=subprocess.run(['node','--test','--test-timeout=10000','test/launch-ingress.test.mjs'],cwd=d,capture_output=True,text=True,timeout=20)
  assert r.returncode==1 and 'ERR_ASSERTION' in r.stdout and 'ERR_MODULE_NOT_FOUND' not in r.stdout and 'SyntaxError' not in r.stdout,label+': survived or invalid failure\n'+r.stdout[-2000:]
  print(label+': detected',flush=True)
print(str(len(mutants))+'/'+str(len(mutants))+' broken ingress guards detected; fixture evidence only, no production routes changed')
