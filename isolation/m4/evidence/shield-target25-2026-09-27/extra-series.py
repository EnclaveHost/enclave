from pathlib import Path
import sys,json,subprocess
w=Path(sys.argv[1]).resolve();args=json.loads((w/'client-args.json').read_text());base=json.loads((w/'quiet-results.json').read_text())[0]['tokens'];rows=[]
for label,steps,mtp,topk in [('topk1',128,0,1),('topk2',128,0,1),('long-plain',384,0,1),('long-mtp1',384,1,1),('long-mtp2',384,1,1)]:
 p=w/(label+'.txt')
 with p.open('w') as f:r=subprocess.run(args+['--path',f'/?graph=qwen3.8-27b-mtp-q4-vl-gguf&steps={steps}&mtp={mtp}&topk={topk}'],stdout=f,stderr=subprocess.STDOUT,timeout=200)
 text=p.read_text();assert r.returncode==0 and 'RESULT gate=open' in text and 'RESULT app_status=200' in text
 body=next(l.removeprefix('RESULT app_body=') for l in text.splitlines() if l.startswith('RESULT app_body='));d=json.loads(json.loads(body));assert len(d['tokens'])==steps and d['tokens'][:128]==base
 if steps==384 and any(x['steps']==384 for x in rows):assert d['tokens']==next(x['result']['tokens'] for x in rows if x['steps']==384)
 rows.append({'label':label,'steps':steps,'result':d});(w/'extra-results.json').write_text(json.dumps(rows,indent=2)+'\n');print(label,{k:v for k,v in d.items() if k!='tokens'},flush=True)
