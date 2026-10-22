import subprocess,json,pathlib
j=json.loads(subprocess.run(['caddy','adapt','--config','/etc/caddy/Caddyfile'],capture_output=True,text=True,check=True).stdout)
print(json.dumps({'manualTLSFiles':j.get('apps',{}).get('tls',{}).get('certificates',{}).get('load_files',[])},indent=2))
base=pathlib.Path('/var/lib/caddy')
for p in base.rglob('*.crt'):
 if p.stem not in ['enclave.host','www.enclave.host','ipfs.enclave.host','api.enclave.host','mcp.enclave.host','get.enclave.host']:continue
 r=subprocess.run(['openssl','x509','-in',str(p),'-noout','-dates','-ext','subjectAltName'],capture_output=True,text=True)
 print(json.dumps({'certificate':str(p),'metadata':r.stdout.strip()}))
