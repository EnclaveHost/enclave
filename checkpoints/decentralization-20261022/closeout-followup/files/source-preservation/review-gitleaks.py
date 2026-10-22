from pathlib import Path
import json,subprocess,re,hashlib
root=Path(__file__).resolve().parents[3]; repo=root/'work/source-checkpoint-20261022/main-repo'
live=root/'work/resume-after-checkpoint-20261022/native-control-attested/repo'
findings=json.loads((Path(__file__).parent/'gitleaks-c23.json').read_text())
published=subprocess.check_output(['git','-C',str(repo),'show','eaea7e4630ee1d82b3599b872a24075691510211:metal/guest/platform-api.bundle.mjs'],text=True)
review=[]
for f in findings:
 p=repo/f['File']; line=p.read_text().splitlines()[f['StartLine']-1]
 if p.name.endswith('.manifest.json'):
  m=re.search(r'"([^"]+)"\s*:\s*"([0-9a-f]{64})"',line);assert m
  assert hashlib.sha256((live/m[1]).read_bytes()).hexdigest()==m[2]
  reason='Recomputed public dependency SHA256: '+m[1]
 else:
  assert p.name=='platform-api.bundle.mjs' and line in published
  assert f['RuleID'] in ['generic-api-key','ethereum-private-key-env']
  reason='Public code expression or AddressBook label; exact line exists in published eaea7e46 bundle'
 review.append({'file':f['File'],'line':f['StartLine'],'rule':f['RuleID'],'classification':reason,'lineSha256':hashlib.sha256(line.encode()).hexdigest()})
out=root/'work/resume-after-checkpoint-20261022/public-validation/gitleaks-review.json'
out.write_text(json.dumps({'commit':'c23dd789c','findings':len(review),'unclassified':0,'review':review},indent=2)+'\n')
print('All',len(review),'gitleaks findings independently classified as public hashes or existing code')
