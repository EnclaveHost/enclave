from pathlib import Path
import shutil,tempfile,subprocess
root=Path(__file__).resolve().parents[1]
mutants=[
 ('owner','probe-old-committee.mjs','s.policy?.owner===AGENT_EOA_29479','true'),
 ('policy-committee','probe-old-committee.mjs','s.policy.committeeId===newCommittee','true'),
 ('exact-refusal','probe-old-committee.mjs',"reply.status===409&&reply.body.error==='wrong_committee'",'true'),
 ('no-extra-payload','probe-old-committee.mjs',"Object.keys(reply.body).every(k=>k==='error'||k==='message')",'true'),
 ('state-race','probe-old-committee.mjs','before[k]===after[k]','true'),
 ('stream-bound','probe.mjs','if(n>4096)throw Error();',''),
 ('challenge-format','probe.mjs',"!/^(0x)?[0-9a-f]{64}$/.test(j.encKey??'')","!/^0x[0-9a-f]{64}$/.test(j.encKey??'')"),
]
for name,file,a,b in mutants:
 with tempfile.TemporaryDirectory(prefix='old-probe-mutant-') as t:
  d=Path(t);shutil.copytree(root/'driver',d/'driver');(d/'test').mkdir();shutil.copy2(root/'test/old-committee.test.mjs',d/'test/old-committee.test.mjs');p=d/'driver'/file;s=p.read_text();assert s.count(a)==1,name;p.write_text(s.replace(a,b))
  r=subprocess.run(['node','--test','--test-timeout=10000','test/old-committee.test.mjs'],cwd=d,capture_output=True,text=True,timeout=20)
  assert r.returncode==1 and ('ERR_ASSERTION' in r.stdout or (name=='challenge-format' and 'custodian challenge shape invalid' in r.stdout)) and 'SyntaxError' not in r.stdout and 'ERR_MODULE_NOT_FOUND' not in r.stdout,name+': survived or invalid failure\n'+r.stdout[-2000:]
  print(name+': detected',flush=True)
print('7/7 broken migration-probe controls detected; real custodian module with synthetic chain data, no hardware evidence')
