import subprocess,json
for host in ['nan','eu-central']:
 r=subprocess.run(['ssh','-o','BatchMode=yes',host,'caddy adapt --config /etc/caddy/Caddyfile'],capture_output=True,text=True)
 if r.returncode: print(host, 'adapt unavailable');continue
 d=json.loads(r.stdout);rows=[]
 def walk(x):
  if isinstance(x,dict):
   if 'host' in x: rows.append({'host':x['host']})
   if 'upstreams' in x: rows.append({'upstreams':[u.get('dial') for u in x['upstreams']]})
   if 'listen' in x: rows.append({'listen':x['listen']})
   for v in x.values():walk(v)
  elif isinstance(x,list):
   for v in x:walk(v)
 walk(d);print(json.dumps({'server':host,'routing':rows}))
