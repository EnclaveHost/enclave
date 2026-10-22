from pathlib import Path
import subprocess,json,hashlib
root=Path(__file__).resolve().parent
rows=[]
for host in ['us-west','eu-central']:
 data=(root/'result'/f'{host}.Caddyfile').read_bytes()
 r=subprocess.run(['ssh','-o','BatchMode=yes','-o','ConnectTimeout=15',host,'/usr/local/lib/enclave-caddy/caddy adapt --config - --adapter caddyfile'],input=data,capture_output=True,timeout=45)
 if r.returncode: raise RuntimeError(r.stderr.decode()[-1000:])
 config=json.loads(r.stdout);(root/'result'/f'{host}.adapted.json').write_bytes(r.stdout)
 matches=[]
 def walk(v):
  if isinstance(v,list):
   for x in v:walk(x)
  elif isinstance(v,dict):
   for group in v.get('match',[]):
    if isinstance(group,dict) and set(group.get('path',[])) & {'/v1/info','/v1/lease'}:matches.append({'match':group,'handle':v.get('handle')})
   for k,x in v.items():
    if k!='match':walk(x)
 walk(config)
 assert len(matches)==3,(host,matches)
 # Caddy sorts mutually exclusive methods by path specificity and wraps handle blocks in subroutes.
 # Both exact allowed routes must precede the catch-all refusal; neither may broaden its matcher.
 assert {json.dumps(m['match'],sort_keys=True) for m in matches[:2]}=={
  json.dumps({'method':['GET'],'path':['/v1/info']},sort_keys=True),
  json.dumps({'method':['POST'],'path':['/v1/lease']},sort_keys=True)},matches
 assert set(matches[2]['match']['path'])=={'/v1/info','/v1/lease'} and set(matches[2]['match'])=={'path'}
 def leaf(h):
  assert isinstance(h,list) and len(h)==1,h
  if h[0].get('handler')=='subroute':
   assert set(h[0])=={'handler','routes'} and len(h[0]['routes'])==1,h
   route=h[0]['routes'][0];assert set(route)=={'handle'},route
   return leaf(route['handle'])
  return h
 for row in matches[:2]:
  h=leaf(row['handle']);assert h==[{'handler':'reverse_proxy','upstreams':[{'dial':'127.0.0.1:8549'}]}],h
 assert leaf(matches[2]['handle'])==[{'handler':'static_response','status_code':405}],matches[2]
 rows.append({'host':host,'sha256':hashlib.sha256(data).hexdigest(),'syntax':'adapted successfully','exactPathsMethodsAndOrdering':True})
print(json.dumps({'status':'PASS: syntax and adapted route structure only; no live routing mutation or end-to-end claim','hosts':rows},indent=2))
(root/'validation.json').write_text(json.dumps({'hosts':rows,'liveMutation':False},indent=2)+'\n')
