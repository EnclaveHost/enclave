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
 results=[]
 for i,file in enumerate(files):
  logpath=p/(label+'-'+str(i)+'.log')
  with logpath.open('x') as log:r=subprocess.run(['unshare','-Urn','sh','-c','ip link set lo up && exec "$@"','owned-loopback','node','--max-old-space-size=140','--max-semi-space-size=4','--test','--experimental-test-isolation=none','--test-concurrency=1','--test-timeout=30000','--import',str(p/'test/helpers/baseline.mjs'),file],stdout=log,stderr=subprocess.STDOUT,env=env,timeout=45)
  counts={k:int(v) for k,v in re.findall(r'^# (tests|pass|fail|cancelled|skipped|todo) (\d+)$',logpath.read_text(),re.M)}
  results.append({'file':file,'rc':r.returncode,'counts':counts});(p/(label+'-files.json')).write_text(json.dumps(results,indent=2)+'\n')
 totals={k:sum(x['counts'].get(k,0) for x in results) for k in ['tests','pass','fail','cancelled','skipped','todo']};expected=93 if label=='historical93' else 8
 summary.append({'suite':label,'expected':expected,'counts':totals,'qualified':all(x['rc']==0 and x['counts'].get('tests',0)>0 for x in results) and totals['tests']==expected and totals['pass']==expected and all(totals[x]==0 for x in ['fail','cancelled','skipped','todo'])})
 (p/'summary.json').write_text(json.dumps(summary,indent=2)+'\n')
check();raise SystemExit(0 if all(x['qualified'] for x in summary) else 1)
