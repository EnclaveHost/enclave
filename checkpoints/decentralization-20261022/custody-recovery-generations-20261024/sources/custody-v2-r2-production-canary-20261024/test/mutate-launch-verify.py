from pathlib import Path
import shutil,tempfile,subprocess
root=Path(__file__).resolve().parents[1]
mutants=[
 ('same-machine',"fields.every(k=>local.machine[k]===publicQuote.machine[k])","true"),
 ('independent-challenges',"local.publicEvidence.challengeSha256!==publicQuote.publicEvidence.challengeSha256","true"),
 ('quote-age',"now()-q.requestedAt<=MAX_QUOTE_AGE_MS","true"),
 ('vcek',"e?.vcekVerified===true","true"),
 ('ingress-race',"routingBefore.bindingDigest===routingAfter.bindingDigest","true"),
 ('host-race',"hostBefore[k]===hostAfter[k]","true"),
 ('process-race',"before[k]===after[k]","true"),
 ('transport-scope',"url===endpoint+'/v2/custody/evidence'&&options?.method==='POST'&&options.redirect==='error'","true"),
]
for label,before,after in mutants:
 with tempfile.TemporaryDirectory(prefix='custody-launch-verify-mutant-') as t:
  d=Path(t);shutil.copytree(root/'driver',d/'driver');(d/'test').mkdir();shutil.copy2(root/'test/launch-verify.test.mjs',d/'test/launch-verify.test.mjs')
  p=d/'driver/launch-verify.mjs';s=p.read_text();assert s.count(before)==1,(label,s.count(before));p.write_text(s.replace(before,after))
  r=subprocess.run(['node','--test','--test-timeout=10000','test/launch-verify.test.mjs'],cwd=d,capture_output=True,text=True,timeout=20)
  assert r.returncode==1 and 'ERR_ASSERTION' in r.stdout and 'ERR_MODULE_NOT_FOUND' not in r.stdout and 'SyntaxError' not in r.stdout,label+': survived or invalid failure\n'+r.stdout[-2000:]
  print(label+': detected',flush=True)
print(str(len(mutants))+'/'+str(len(mutants))+' broken combined-launch guards detected; synthetic evidence only')
