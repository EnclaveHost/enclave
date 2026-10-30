from pathlib import Path
import subprocess,os,json
p=Path(__file__).resolve().parent
os.sched_setaffinity(0,{min(os.sched_getaffinity(0))})
b=Path('/home/steven/Documents/Codex/2026-10-23/it/work/enclave-deployment-lifecycle')
steps=[('fixed-composition',['node','--test','--test-concurrency=1',*map(str,sorted((p/'test').glob('*.test.mjs')))],1),('runner-proof-regressions',['node','--import',str(p/'baseline-test-hook.mjs'),'--test','--test-concurrency=1',str(b/'test/deployment-lifecycle-runner.test.mjs'),str(b/'test/deployment-generation-certificate.test.mjs')],0)]
results=[]
for name,cmd,expected in steps:
 with (p/(name+'.log')).open('x') as log: r=subprocess.run(cmd,cwd=p,stdout=log,stderr=subprocess.STDOUT,timeout=180)
 results.append({'name':name,'exitCode':r.returncode,'expectedExitCode':expected})
 (p/'fixed-results.json').write_text(json.dumps(results,indent=2)+'\n')
 if r.returncode!=expected: raise SystemExit(r.returncode or 1)
