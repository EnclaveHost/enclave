from pathlib import Path
import os,subprocess,json,hashlib,re
p=Path(__file__).resolve().parent;u=p.parent
os.sched_setaffinity(0,{min(os.sched_getaffinity(0))})
pins=json.loads((p/'pins.json').read_text())
def check():
 for f,h in pins.items():assert hashlib.sha256(Path(f).read_bytes()).hexdigest()==h,f
check();env=dict(os.environ,LIFECYCLE_REVIEW_R2=str(u/'lifecycle-host-authority-review-r2'),LIFECYCLE_R6_ADAPTER=str(u.parent/'lifecycle-chain-adapter-stage/r6/network/deployment-chain-adapter.mjs'))
summary=[]
for label,files in json.loads((p/'selection.json').read_text()).items():
 with (p/(label+'.log')).open('x') as log:r=subprocess.run(['unshare','-Urn','node','--max-old-space-size=160','--max-semi-space-size=4','--test','--experimental-test-isolation=none','--test-concurrency=1','--test-timeout=30000','--import',str(p/'test/helpers/baseline.mjs'),*files],stdout=log,stderr=subprocess.STDOUT,env=env,timeout=100)
 counts={k:int(v) for k,v in re.findall(r'^# (tests|pass|fail|cancelled|skipped|todo) (\d+)$',(p/(label+'.log')).read_text(),re.M)}
 expected=93 if label=='historical93' else 8
 summary.append({'suite':label,'rc':r.returncode,'expected':expected,'counts':counts,'qualified':r.returncode==0 and counts.get('tests')==expected and counts.get('pass')==expected and all(counts.get(x)==0 for x in ['fail','cancelled','skipped','todo'])})
 (p/'summary.json').write_text(json.dumps(summary,indent=2)+'\n')
check();raise SystemExit(0 if all(x['qualified'] for x in summary) else 1)
