import subprocess,json
p=subprocess.run(['caddy','adapt','--config','/etc/caddy/Caddyfile'],capture_output=True,text=True,check=True);j=json.loads(p.stdout)
allowed={'handler','host','path','uri','root','dial','listen','status_code','body','strip_path_prefix','strip_path_suffix','match','terminal'}
def clean(v):
 if isinstance(v,dict):
  return {k:clean(x) for k,x in v.items() if k in allowed or isinstance(x,(list,dict)) and k not in ['headers','header','credentials','authentication','tls_connection_policies','apps','logging']}
 if isinstance(v,list):return [clean(x) for x in v]
 return v
print(json.dumps(clean(j['apps']['http']),indent=2))
