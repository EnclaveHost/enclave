import pathlib,subprocess,json,urllib.parse,re
services=['enclave-api-relay','enclave-dns','enclave-native-discovery','nan-wasm-gateway','enclave-policy-migration-bridge','enclave-provider-migration-mirror']
out=[]
for s in services:
 pid=subprocess.check_output(['systemctl','show',s,'-p','MainPID','--value'],text=True).strip()
 if pid=='0':continue
 e=dict(x.split('=',1) for x in pathlib.Path('/proc/'+pid+'/environ').read_bytes().decode().split('\0') if '=' in x)
 endpoints={}
 for k,v in e.items():
  if any(w in k for w in ['KEY','TOKEN','SECRET','PASSWORD','SEED']) and not k.startswith('SECRETS_RELEASE_'):continue
  hosts=[]
  for match in re.finditer(r'https?://[^\s,]+',v):
   try:
    u=urllib.parse.urlsplit(match.group());hosts.append({'scheme':u.scheme,'host':u.hostname,'port':u.port})
   except ValueError:pass
  if hosts:endpoints[k]=hosts
 out.append({'service':s,'endpoints':endpoints})
print(json.dumps(out,indent=2))
