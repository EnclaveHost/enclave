import subprocess,concurrent.futures,json
from pathlib import Path
p=Path(__file__).resolve().parent
commands=[['node',str(p/'publisher-chain.mjs')],['python3',str(p/'publisher-status.py')]]
def run(c):
 r=subprocess.run(c,capture_output=True,text=True,timeout=90)
 (p/(Path(c[-1]).stem+'.out')).write_text(r.stdout+r.stderr)
 return {'command':Path(c[-1]).name,'returncode':r.returncode}
with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:results=list(pool.map(run,commands))
print(json.dumps(results));raise SystemExit(0 if all(r['returncode']==0 for r in results) else 1)
