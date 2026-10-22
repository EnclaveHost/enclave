from pathlib import Path
import json,re,subprocess,hashlib
root=Path(__file__).resolve().parents[3];base=root/'work/resume-after-checkpoint-20261022';repo=root/'work/source-checkpoint-20261022/main-repo'
findings=json.loads((base/'source-preservation/native-final-checkpoint-gitleaks.json').read_text());assert len(findings)==2
rows=[]
for f in findings:
 assert f['RuleID']=='generic-api-key' and f['File'].endswith('native-final-image/public/BUILD-RECEIPT.json')
 lines=(repo/f['File']).read_text().splitlines()[f['StartLine']-1:f['EndLine']]
 commits=[]
 for line in lines:
  text=json.loads(line.strip().removesuffix(','));sha,subject=text.split(' ',1);assert re.fullmatch('[0-9a-f]{40}',sha)
  actual=subprocess.check_output(['git','-C',str(repo),'show','-s','--format=%H %s',sha],text=True).strip();assert actual==text
  commits.append(sha)
 rows.append({'file':f['File'],'start':f['StartLine'],'end':f['EndLine'],'rule':f['RuleID'],'classification':'Public Git commit hashes and subjects, independently matched to committed Git objects','commits':commits})
r={'scope':'Staged closeout checkpoint after ad5107deb','cryptoFindings':0,'gitleaksFindings':2,'unclassified':0,'review':rows}
(base/'public-validation/native-final-checkpoint-scan-review.json').write_text(json.dumps(r,indent=2)+'\n');print('Verified two findings: public Git commit hashes and subjects only')
