"""Local only: the checks apply-edge.py makes before it contacts an edge, for every edge, from the captures on disk."""
from pathlib import Path
import json,hashlib
p=Path(__file__).resolve().parent
j=json.loads((p/'release.json').read_text());base=json.loads((p/'base-files.json').read_text())
old='/opt/enclave-site/'+j['baseCid']+'/site'
for h in ['us-west','ca-east','ap-southeast','eu-central']:
 b=json.loads((p/(h+'.current.json')).read_text())
 assert b['files']==base and b['activeRoot']==old and b['caddyfile'].count(old)==2
 n=[0]
 def walk(v):
  if isinstance(v,dict):[walk(x) for x in v.values()]
  elif isinstance(v,list):[walk(x) for x in v]
  elif v==old:n[0]+=1
 walk(b['config']);assert n[0]==2,h
size=0
for name,pin in j['delta'].items():
 c=(p/'composite/site'/name).read_bytes();assert hashlib.sha256(c).hexdigest()==pin;size+=len(c)
assert [x for x in j['delta'] if x in base]==['js/boot.js']
assert all(j['files'][k]==v for k,v in base.items() if k!='js/boot.js') and len(j['files'])==len(base)+len(j['delta'])-1
print(json.dumps({'cid':j['cid'],'edgesReady':4,'additions':len(j['delta']),'additionBytes':size,'treeFiles':len(j['files'])}))
