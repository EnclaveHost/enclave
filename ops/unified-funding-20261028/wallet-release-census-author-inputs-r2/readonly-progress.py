from pathlib import Path
from datetime import datetime
import json,hashlib,time
p=Path(__file__).resolve().parent;start=json.loads((p/'started.json').read_text())['startedAt'];seed=json.loads((p/'seed-pins.json').read_text());counts={};last=[]
for f in (Path('/home/steven/.claude/projects')/str(p).replace('/','-')).glob('*.jsonl'):
 for line in f.read_text().splitlines():
  try:d=json.loads(line);ts=datetime.fromisoformat(d.get('timestamp','').replace('Z','+00:00')).timestamp()
  except (ValueError,TypeError):continue
  if ts<start:continue
  bs=d.get('message',{}).get('content',[])
  if not isinstance(bs,list):continue
  for b in bs:
   if isinstance(b,dict) and b.get('type')=='tool_use':
    n=b.get('name');counts[n]=counts.get(n,0)+1
    if n in ('Write','Edit'):last.append(b.get('input',{}).get('file_path'))
changed=[str(f.relative_to(p/'candidate')) for f in (p/'candidate').rglob('*') if f.is_file() and hashlib.sha256(f.read_bytes()).hexdigest()!=seed.get(str(f.relative_to(p/'candidate')))];print(json.dumps({'elapsedSec':round(time.time()-start),'terminal':(p/'finished.json').exists(),'tools':counts,'changed':changed,'lastMutations':last[-3:]}))
