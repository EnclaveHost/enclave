from pathlib import Path
import concurrent.futures,subprocess,json,datetime
p=Path(__file__).resolve().parent
def run(item):
 name,cmd=item
 with (p/(name+'-r2.out')).open('x') as f:
  try:
   r=subprocess.run(cmd,stdout=f,stderr=subprocess.STDOUT,timeout=100)
   return {'name':name,'exit':r.returncode}
  except subprocess.TimeoutExpired:return {'name':name,'timeout':True}
with concurrent.futures.ThreadPoolExecutor(max_workers=2) as ex:r=list(ex.map(run,[('http',['python3',str(p/'public-http.py')]),('ipns',['node',str(p/'ipns-check.mjs')])]))
out={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'collection':r}
(p/'collection.json').write_text(json.dumps(out,indent=2)+'\n')
print(json.dumps(out));raise SystemExit(0 if all(x.get('exit')==0 for x in r) else 1)
