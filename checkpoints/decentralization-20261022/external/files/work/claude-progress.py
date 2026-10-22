from pathlib import Path
import json,sys,datetime
names=sys.argv[1:] or [x['name'] for x in json.loads(Path(__file__).with_name('claude-workstreams.json').read_text())['workstreams']]
root=Path(__file__).parent
for name in names:
 entry=next((x for x in json.loads((root/'claude-workstreams.json').read_text())['workstreams'] if x['name']==name), {})
 p=Path(entry['outputLog']) if entry.get('outputLog') else root/f'claude-{name}-session.jsonl';texts=[];calls=[];result=None
 for line in p.read_text().splitlines():
  try:x=json.loads(line)
  except ValueError:continue
  if x.get('type')=='assistant' and isinstance(x.get('message'),dict):
   result=None
   for c in x.get('message',{}).get('content',[]):
    if c.get('type')=='text':texts.append(c['text'][:1800])
    elif c.get('type')=='tool_use':calls.append(c.get('name','')+' '+str(c.get('input',{}).get('file_path','')))
  if x.get('type')=='result':result={'status':x.get('subtype'),'permissionDenials':len(x.get('permission_denials',[])),'summary':str(x.get('result',''))[:1800]}
 print(json.dumps({'name':name,'lastEvent':datetime.datetime.fromtimestamp(p.stat().st_mtime,datetime.timezone.utc).isoformat(),'latestText':texts[-1:] ,'latestTools':calls[-2:],'result':result}))
