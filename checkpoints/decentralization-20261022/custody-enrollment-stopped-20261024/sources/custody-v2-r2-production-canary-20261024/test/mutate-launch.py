from pathlib import Path
import shutil,tempfile,subprocess,re
root=Path(__file__).resolve().parents[1]
mutants=[
 ('capture-binding','pins.custodian.captureDir===path.join(bundle,"capture")','true'),
 ('artifact-bytes',"need(digestFile(f)===sha256hex(body),'artifact bytes changed')","need(true,'artifact bytes changed')"),
 ('current-inputs',"need(made.digest===expectedDigest,'current source, configuration or binary pins differ')","need(true,'current source, configuration or binary pins differ')"),
 ('fresh-state',"if(requireFresh)need(fs.readdirSync(d).length===0,'state or capture is not fresh; explicit recovery procedure required')","if(false)need(fs.readdirSync(d).length===0,'state or capture is not fresh; explicit recovery procedure required')"),
 ('environment',"environment:{PATH:'/usr/bin:/bin'","environment:{UNREVIEWED_INHERITED_SETTING:'fixture',PATH:'/usr/bin:/bin'"),
 ('extra-entry',"need(fs.readdirSync(bundle).sort().join(',')===[...Object.keys(made.artifacts),'launch.json','state','capture'].sort().join(','),'unexpected launch-package entry')","need(true,'unexpected launch-package entry')"),
]
for label,before,after in mutants:
 with tempfile.TemporaryDirectory(prefix='custody-launch-mutant-') as t:
  d=Path(t);shutil.copytree(root/'driver',d/'driver');(d/'test').mkdir();shutil.copy2(root/'test/launch-bundle.test.mjs',d/'test/launch-bundle.test.mjs')
  p=d/'driver/launch-bundle.mjs';s=p.read_text();assert s.count(before)==1;p.write_text(s.replace(before,after))
  r=subprocess.run(['node','--test','test/launch-bundle.test.mjs'],cwd=d,capture_output=True,text=True,timeout=30)
  assert r.returncode and 'ERR_ASSERTION' in r.stdout and 'ERR_MODULE_NOT_FOUND' not in r.stdout and 'SyntaxError' not in r.stdout,label+': survived or invalid failure\n'+r.stdout[-2000:]
  print(label+': detected',flush=True)
print(str(len(mutants))+'/'+str(len(mutants))+' broken launch-package guards detected; offline only')
