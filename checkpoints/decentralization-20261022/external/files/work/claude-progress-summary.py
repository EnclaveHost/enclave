import json,sys
from pathlib import Path
for n in sys.argv[1:]:
 p=Path('work/claude-'+n+'.jsonl');texts=[];last=[]
 if not p.exists():continue
 for l in p.open():
  try:r=json.loads(l)
  except:continue
  if not isinstance(r,dict):continue
  last.append((r.get('type'),r.get('subtype'),r.get('timestamp')))
  m=r.get('message',{})
  cs=m.get('content',[]) if isinstance(m,dict) else []
  for c in cs if isinstance(cs,list) else []:
   if isinstance(c,dict) and c.get('type')=='text':texts.append(c['text'])
 print(n, '\n'.join(texts[-2:])[-2400:], 'LAST',last[-2:])
